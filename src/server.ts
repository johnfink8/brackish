// Hono app + dual-bind serve. Unix socket is always bound (peer-trust auth via
// X-Brackish-Identity header); TCP is bound additionally when ServerConfig.bind is set
// (bearer-token auth via Authorization: Bearer).

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { type AppBindings, type AppVariables, makeAuthMiddleware } from './auth.js';
import { ensureBrackishHome, parseBindAddress, type ServerConfig } from './config.js';
import {
  CreateDocumentRequestSchema,
  CreateInviteRequestSchema,
  type Cursor,
  type DocumentName,
  DocumentNameSchema,
  type Event,
  IdentitySchema,
  RedeemInviteRequestSchema,
  SendMessageRequestSchema,
} from './models.js';
import { EventNotifier } from './notifier.js';
import type { Store } from './store/index.js';
import { SqliteStore, StoreError } from './store/sqlite.js';

const SERVER_VERSION = '0.1.0';

const WAIT_TIMEOUT_DEFAULT_S = 30;
const WAIT_TIMEOUT_MIN_S = 1;
const WAIT_TIMEOUT_MAX_S = 300;
const EVENT_PAGE_DEFAULT = 200;
const EVENT_PAGE_MAX = 1000;

type AppEnv = { Variables: AppVariables; Bindings: AppBindings };

export type BuildAppOptions = {
  store: Store;
  notifier: EventNotifier;
};

/** Build the Hono app. Exported so tests can hit `app.fetch` directly without binding a port. */
export function buildApp(opts: BuildAppOptions): Hono<AppEnv> {
  const { store, notifier } = opts;
  const app = new Hono<AppEnv>();

  // Centralized error mapping for StoreError -> HTTP status.
  app.onError((err, c) => {
    if (err instanceof StoreError) {
      const status = storeErrorStatus(err.code);
      return c.json({ error: err.message, code: err.code }, status);
    }
    console.error('[brackish] unhandled error:', err);
    return c.json({ error: 'internal server error' }, 500);
  });

  // --- public (no-auth) routes ---

  app.get('/healthz', (c) => c.json({ ok: true, version: SERVER_VERSION }));

  app.post('/connect', async (c) => {
    const body = RedeemInviteRequestSchema.parse(await c.req.json());
    const { identity, token } = await store.redeemInvite(body.inviteToken);
    return c.json({ identity, token });
  });

  // --- authenticated routes ---

  const auth = app.use('*', async (c, next) => {
    // /healthz and /connect are public; skip auth for them.
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz' || path === '/connect') return next();
    return makeAuthMiddleware(store)(c, next);
  });
  void auth;

  app.get('/whoami', (c) => c.json({ identity: c.get('identity'), serverVersion: SERVER_VERSION }));

  app.post('/invites', async (c) => {
    const body = CreateInviteRequestSchema.parse(await c.req.json());
    const invite = await store.createInvite(body.identity, body.ttlSeconds);
    return c.json({
      inviteToken: invite.token,
      identity: invite.identity,
      expiresAt: invite.expiresAt,
    });
  });

  app.get('/parties', async (c) => {
    const parties = await store.listParties();
    return c.json({ parties });
  });

  app.delete('/parties/:identity', async (c) => {
    const identity = IdentitySchema.parse(c.req.param('identity'));
    await store.revokeParty(identity);
    return c.json({ ok: true });
  });

  // --- documents ---

  app.get('/documents', async (c) => {
    const documents = await store.listDocuments();
    return c.json({ documents });
  });

  app.post('/documents', async (c) => {
    const body = CreateDocumentRequestSchema.parse(await c.req.json());
    const document = await store.createDocument(body.name, c.get('identity'));
    return c.json(document, 201);
  });

  app.get('/documents/:name', async (c) => {
    const name = DocumentNameSchema.parse(c.req.param('name'));
    const t = await store.getDocument(name);
    if (!t)
      return c.json({ error: `document "${name}" not found`, code: 'document_not_found' }, 404);
    return c.json(t);
  });

  // --- messages and events ---

  app.post('/documents/:name/messages', async (c) => {
    const name = DocumentNameSchema.parse(c.req.param('name'));
    const body = SendMessageRequestSchema.parse(await c.req.json());
    const event = await store.appendMessage(name, c.get('identity'), body.text);
    return c.json({ event }, 201);
  });

  app.get('/documents/:name/events', async (c) => {
    const name = DocumentNameSchema.parse(c.req.param('name'));
    const identity = c.get('identity');
    const since = parseSince(c.req.query('since'));
    const limit = parseLimit(c.req.query('limit'));
    const events = await store.listEvents(name, since ?? 0, limit);
    const lastCursor = await advanceCursorForRead(store, identity, name, events, since ?? 0);
    return c.json({ events, cursor: lastCursor });
  });

  app.get('/documents/:name/wait', async (c) => {
    const name = DocumentNameSchema.parse(c.req.param('name'));
    const identity = c.get('identity');
    const sinceParam = parseSince(c.req.query('since'));
    const since =
      sinceParam !== undefined ? sinceParam : await store.getLastSeenCursor(identity, name);
    const timeoutS = clampTimeoutSeconds(c.req.query('timeout'));

    const events = await waitForEvents(store, notifier, name, since, timeoutS * 1000);
    const lastCursor = await advanceCursorForRead(store, identity, name, events, since);
    return c.json({ events, cursor: lastCursor });
  });

  app.get('/inbox', async (c) => {
    const identity = c.get('identity');
    const documents = await store.inboxSummary(identity);
    return c.json({ identity, documents });
  });

  return app;
}

// --- helpers ---

function storeErrorStatus(code: string): 400 | 401 | 403 | 404 | 409 {
  switch (code) {
    case 'document_not_found':
    case 'artifact_not_found':
    case 'invite_invalid':
      return 404;
    case 'document_exists':
    case 'artifact_not_pending':
    case 'invite_redeemed':
    case 'invite_expired':
      return 409;
    case 'cannot_accept_own':
    case 'cannot_reject_own':
      return 403;
    default:
      return 400;
  }
}

function parseSince(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, 'invalid "since" cursor');
  }
  return n;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return EVENT_PAGE_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new HttpError(400, 'invalid "limit"');
  }
  return Math.min(n, EVENT_PAGE_MAX);
}

function clampTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return WAIT_TIMEOUT_DEFAULT_S;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return WAIT_TIMEOUT_DEFAULT_S;
  return Math.min(Math.max(n, WAIT_TIMEOUT_MIN_S), WAIT_TIMEOUT_MAX_S);
}


/** Long-poll wait: register a notifier resolver, race against timeout, race-guard against
 *  events that landed between the caller calling `since` and our register. */
function waitForEvents(
  store: Store,
  notifier: EventNotifier,
  documentName: DocumentName,
  since: Cursor,
  timeoutMs: number,
): Promise<Event[]> {
  return new Promise<Event[]>((resolve) => {
    let settled = false;
    let unregister: () => void = () => {};
    let timer: NodeJS.Timeout | undefined;

    const settle = (events: Event[]): void => {
      if (settled) return;
      settled = true;
      unregister();
      if (timer !== undefined) clearTimeout(timer);
      resolve(events);
    };

    const drainAndMaybeSettle = (): void => {
      void store.listEvents(documentName, since, EVENT_PAGE_MAX).then((events) => {
        if (events.length > 0) settle(events);
      });
    };

    unregister = notifier.register(documentName, drainAndMaybeSettle);
    timer = setTimeout(() => settle([]), timeoutMs);
    drainAndMaybeSettle(); // race-guard for events that arrived before we registered
  });
}

async function advanceCursorForRead(
  store: Store,
  identity: string,
  documentName: DocumentName,
  events: Event[],
  fallback: Cursor,
): Promise<Cursor> {
  if (events.length === 0) return fallback;
  const last = events[events.length - 1];
  if (!last) return fallback;
  await store.advanceCursor(identity, documentName, last.id);
  return last.id;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// --- lifecycle: start / stop the dual-bind server ---

export type RunningServer = {
  store: Store;
  notifier: EventNotifier;
  socketPath: string;
  tcpAddress: { host: string; port: number } | null;
  close(): Promise<void>;
};

export async function startServer(opts: { config: ServerConfig }): Promise<RunningServer> {
  ensureBrackishHome();
  const notifier = new EventNotifier();
  const store = new SqliteStore({ path: opts.config.dataPath, notifier });
  const app = buildApp({ store, notifier });
  const listener = getRequestListener(app.fetch);

  if (existsSync(opts.config.socketPath)) {
    unlinkSync(opts.config.socketPath);
  }

  const socketServer = createServer(listener);
  await listenAsync(socketServer, { path: opts.config.socketPath });
  chmodSync(opts.config.socketPath, 0o600);

  let tcpServer: HttpServer | undefined;
  let tcpAddress: { host: string; port: number } | null = null;
  if (opts.config.bind !== undefined) {
    const { host, port } = parseBindAddress(opts.config.bind);
    tcpServer = createServer(listener);
    await listenAsync(tcpServer, { host, port });
    const addr = tcpServer.address();
    if (addr && typeof addr === 'object' && 'port' in addr) {
      tcpAddress = { host, port: addr.port };
    } else {
      tcpAddress = { host, port };
    }
  }

  return {
    store,
    notifier,
    socketPath: opts.config.socketPath,
    tcpAddress,
    async close() {
      await closeServer(socketServer);
      if (tcpServer) await closeServer(tcpServer);
      await store.close();
      if (existsSync(opts.config.socketPath)) {
        unlinkSync(opts.config.socketPath);
      }
    },
  };
}

type ListenOptions = { path: string } | { host: string; port: number };

function listenAsync(server: HttpServer, opts: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if ('path' in opts) {
      server.listen({ path: opts.path });
    } else {
      server.listen({ host: opts.host, port: opts.port });
    }
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

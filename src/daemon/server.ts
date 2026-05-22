// Hono app + dual-bind serve. Unix socket is always bound (peer-trust auth via
// X-Brackish-Identity header); TCP is bound additionally when ServerConfig.bind is set
// (bearer-token auth via Authorization: Bearer).

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { stringify as yamlStringify } from 'yaml';
import { ZodError } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { ensureBrackishHome, parseBindAddress, type ServerConfig } from '../io/config.js';
import { generatePatch } from '../lib/diff.js';
import {
  AcceptArtifactRequestSchema,
  AddMemberRequestSchema,
  type ConventionSpec,
  CreateDocumentRequestSchema,
  CreateInviteRequestSchema,
  type Cursor,
  type DocumentName,
  DocumentNameSchema,
  type Event,
  type HttpMethod,
  IdentitySchema,
  type JSONSchema,
  type OperationSpec,
  ProposeBatchRequestSchema,
  ProposeConventionRequestSchema,
  ProposeEndpointRequestSchema,
  ProposeSchemaRequestSchema,
  parseOperationIdentityKey,
  RedeemInviteRequestSchema,
  RejectArtifactRequestSchema,
  SchemaNameSchema,
  SendMessageRequestSchema,
} from '../lib/models.js';
import { EventNotifier } from '../lib/notifier.js';
import { RateLimiter } from './limiter.js';
import type { assembleDocument } from '../lib/openapi.js';
import { validateDocument } from '../lib/validate.js';
import { type RationaleMap, renderHtml } from '../render/render.js';
import { type AppBindings, type AppVariables, makeAuthMiddleware } from './auth.js';
import { operationKey, projectDocument } from './projection.js';
import type { Store } from './store/index.js';
import { SqliteStore, StoreError } from './store/sqlite.js';

// Inlined by esbuild at build time from package.json. Same trick as src/cli.ts's CLI_VERSION;
// keeps the version reported by /healthz and /whoami in sync with the published package.
const SERVER_VERSION = pkg.version;

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

  // Three TCP-only rate limiters. Socket callers bypass each one (peer-trust + the
  // filesystem permission on the socket already gate access). Keys are source IP for
  // network-facing endpoints and identity for the authenticated OTT mint.
  const connectLimiter = new RateLimiter({ burst: 10, windowSeconds: 60 });
  const failedAuthLimiter = new RateLimiter({ burst: 20, windowSeconds: 60 });
  const ottMintLimiter = new RateLimiter({ burst: 30, windowSeconds: 60 });

  const sourceIp = (c: import('hono').Context<AppEnv>): string =>
    c.env.incoming.socket.remoteAddress ?? 'unknown';

  const isTcp = (c: import('hono').Context<AppEnv>): boolean => {
    const addr = c.env.incoming.socket.address?.();
    return Boolean(addr && typeof addr === 'object' && 'port' in addr);
  };

  /** Doc-scoped ACL gate. Sock transport bypasses (peer-trust); TCP enforces membership.
   *  Returns null when access is allowed, or a Response (404/403) to short-circuit. */
  const requireMember = async (
    c: import('hono').Context<AppEnv>,
    docName: DocumentName,
  ): Promise<Response | null> => {
    if (c.get('transport') === 'sock') return null;
    const doc = await store.getDocument(docName);
    if (!doc) {
      return c.json(
        { error: `document "${docName}" not found`, code: 'document_not_found' },
        404,
      );
    }
    const ok = await store.isMember(docName, c.get('identity'));
    if (!ok) {
      return c.json(
        { error: `not a member of "${docName}"`, code: 'forbidden' },
        403,
      );
    }
    return null;
  };

  // Centralized error mapping. Three classes get specific status codes; everything
  // else is logged and surfaces as 500.
  app.onError((err, c) => {
    if (err instanceof StoreError) {
      const status = storeErrorStatus(err.code);
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      }));
      return c.json({ error: 'validation failed', code: 'bad_request', issues }, 400);
    }
    console.error('[brackish] unhandled error:', err);
    return c.json({ error: 'internal server error' }, 500);
  });

  // --- public (no-auth) routes ---

  app.get('/healthz', (c) => c.json({ ok: true, version: SERVER_VERSION }));

  app.post('/connect', async (c) => {
    if (isTcp(c)) {
      const key = `connect:${sourceIp(c)}`;
      if (!connectLimiter.tryConsume(key)) {
        const retry = connectLimiter.retryAfterSeconds(key);
        c.header('Retry-After', String(retry));
        console.warn(`[brackish] rate-limited /connect from ${sourceIp(c)}`);
        return c.json({ error: 'too many requests', code: 'rate_limited' }, 429);
      }
    }
    const body = RedeemInviteRequestSchema.parse(await c.req.json());
    const { identity, token } = await store.redeemInvite(body.inviteToken);
    return c.json({ identity, token });
  });

  // /ui-login is a public route that consumes a one-time UI token (OTT) minted by an
  // authenticated caller via POST /ui-sessions. Success path sets an HttpOnly cookie
  // and 302s to the doc UI; failure path returns a plain 401. This is the ONLY way
  // a browser obtains brackish auth after 0.6.0 (the ?token= query fallback is gone).
  app.get('/ui-login', async (c) => {
    const ott = c.req.query('ott');
    const docRaw = c.req.query('doc');
    if (!ott) return c.json({ error: '?ott=… required' }, 401);
    const redeemed = await store.redeemUiOtt(ott);
    if (!redeemed) return c.json({ error: 'invalid or expired OTT' }, 401);
    const redirect = docRaw ? `/ui/${encodeURIComponent(docRaw)}` : '/ui';
    // HttpOnly + SameSite=Strict prevent JS access and cross-site abuse. Path scoped
    // to /ui so the cookie isn't sent on every API call; Authorization-bearer is
    // still the auth mechanism for non-UI HTTP. Secure flag is intentionally omitted
    // for loopback HTTP — TLS termination is the user's responsibility for non-local
    // binds (documented in the security model section).
    c.header(
      'Set-Cookie',
      `brackish_ui=${redeemed.cookieToken}; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=3600`,
    );
    return c.redirect(redirect, 302);
  });

  // --- authenticated routes ---

  const authMiddleware = makeAuthMiddleware(store, { failedAuthLimiter });
  const auth = app.use('*', async (c, next) => {
    // /healthz, /connect, and /ui-login are public; skip auth for them.
    // /ui-login is the OTT redeemer — it consumes a single-use token from the URL and
    // sets an HttpOnly cookie; auth happens via that mechanism, not Bearer.
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz' || path === '/connect' || path === '/ui-login') return next();
    return authMiddleware(c, next);
  });
  void auth;

  // Authenticated endpoint to mint a OTT for browser handoff. The caller (Claude over
  // socket, or a TCP peer via Bearer) trades a real bearer token for a single-use OTT
  // that can ride in a URL; the browser visits /ui-login?ott=… to exchange it for a
  // cookie. No spec body needed — the OTT inherits the caller's identity at mint time.
  app.post('/ui-sessions', async (c) => {
    if (c.get('transport') === 'tcp') {
      const key = `ott:${c.get('identity')}`;
      if (!ottMintLimiter.tryConsume(key)) {
        const retry = ottMintLimiter.retryAfterSeconds(key);
        c.header('Retry-After', String(retry));
        return c.json({ error: 'too many requests', code: 'rate_limited' }, 429);
      }
    }
    const { ott, expiresAt } = await store.createUiOtt(c.get('identity'), 60);
    return c.json({ ott, expiresAt }, 201);
  });

  app.get('/whoami', (c) => c.json({ identity: c.get('identity'), serverVersion: SERVER_VERSION }));

  app.post('/invites', async (c) => {
    const body = CreateInviteRequestSchema.parse(await c.req.json());
    const invite = await store.createInvite(body.identity, body.ttlSeconds, body.grantDocs ?? []);
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
    // TCP callers see only docs they're a member of; sock peers (peer-trust) see all.
    const documents =
      c.get('transport') === 'sock'
        ? await store.listDocuments()
        : await store.listDocumentsForMember(c.get('identity'));
    return c.json({ documents });
  });

  app.post('/documents', async (c) => {
    const body = CreateDocumentRequestSchema.parse(await c.req.json());
    const document = await store.createDocument(body.name, c.get('identity'));
    return c.json(document, 201);
  });

  // Middleware: every doc-scoped route (everything matching /documents/:name/*) is
  // gated on ACL membership for TCP callers; sock callers bypass (peer-trust). We
  // attach this BEFORE the routes themselves so per-handler bodies stay clean.
  app.use('/documents/:name/*', async (c, next) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const denied = await requireMember(c, docName);
    if (denied) return denied;
    await next();
  });

  app.get('/documents/:name', async (c) => {
    const name = DocumentNameSchema.parse(c.req.param('name'));
    const denied = await requireMember(c, name);
    if (denied) return denied;
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
    const tail = parseTail(c.req.query('tail'));
    if (tail !== undefined) {
      // --tail is a read-only peek at the end of the log. Don't advance the caller's cursor —
      // the whole point is to inspect recent events without consuming them.
      const events = await store.listLastEvents(name, tail);
      const cursor = await store.getLastSeenCursor(identity, name);
      return c.json({ events, cursor });
    }
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

  // --- atomic propose-batch ---
  //
  // The arbitrator's bulk-insert path. Accepts a coordinated set of artifacts (convention +
  // schemas + endpoints), assembles them all into the projected wide doc at once, runs the
  // meta-schema validator on the whole assembled doc, and commits all-or-nothing.
  //
  // Why atomic: per-artifact propose requires the dependency to be already in the doc, so
  // proposing `MessageList` (refs `Message`) before proposing `Message` would fail. In a batch,
  // the user expressed a coordinated set; order within the batch shouldn't matter. The batch
  // handler simulates all items into the wide doc before validating, so mutual / forward-ref
  // patterns work as long as every ref resolves somewhere within the assembled doc.
  app.post('/documents/:name/propose-batch', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeBatchRequestSchema.parse(await c.req.json());

    const overlay: {
      convention?: ConventionSpec | null;
      schemas?: Map<string, JSONSchema>;
      operations?: Map<string, { method: HttpMethod; path: string; spec: OperationSpec }>;
    } = {};
    if (body.convention) overlay.convention = body.convention.spec;
    if (body.schemas && body.schemas.length > 0) {
      overlay.schemas = new Map();
      for (const s of body.schemas) overlay.schemas.set(s.name, s.spec);
    }
    if (body.endpoints && body.endpoints.length > 0) {
      overlay.operations = new Map();
      for (const e of body.endpoints) {
        overlay.operations.set(operationKey(e.method, e.path), {
          method: e.method,
          path: e.path,
          spec: e.spec,
        });
      }
    }

    const projected = await projectDocument(store, docName, 'wide', overlay);
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        { error: 'invalid OpenAPI 3.1 spec', code: 'spec_invalid', issues: invalid.errors },
        400,
      );
    }

    // Atomic commit via Store.batchPropose: one outer SQLite transaction wraps the
    // per-artifact proposes as savepoints. Any failure mid-batch rolls back every
    // earlier propose, so partial state is impossible. The doc was already validated
    // as a whole above, so individual proposes resolve refs correctly.
    const identity = c.get('identity');
    const input: import('./store/index.js').BatchProposeInput = {};
    if (body.convention) {
      input.convention = { spec: body.convention.spec };
      const opts = toProposeOptions(body.convention.options);
      if (Object.keys(opts).length > 0) input.convention.opts = opts;
    }
    if (body.schemas) {
      input.schemas = body.schemas.map((s) => {
        const item: NonNullable<typeof input.schemas>[number] = { name: s.name, spec: s.spec };
        const opts = toProposeOptions(s.options);
        if (Object.keys(opts).length > 0) item.opts = opts;
        return item;
      });
    }
    if (body.endpoints) {
      input.endpoints = body.endpoints.map((e) => {
        const item: NonNullable<typeof input.endpoints>[number] = {
          method: e.method,
          path: e.path,
          spec: e.spec,
        };
        const opts = toProposeOptions(e.options);
        if (Object.keys(opts).length > 0) item.opts = opts;
        return item;
      });
    }
    try {
      const succeeded = await store.batchPropose(docName, input, identity);
      return c.json({ succeeded }, 201);
    } catch (err) {
      // The whole batch rolled back. Surface the failure shape (mirroring per-propose
      // errors) so the caller can reconcile, with no `succeeded` field — atomic means
      // there is nothing partial to report.
      const status = err instanceof StoreError ? storeErrorStatus(err.code) : 500;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof StoreError ? err.code : null;
      return c.json({ error: message, code }, status);
    }
  });

  // --- endpoints (operation artifacts) ---

  app.post('/documents/:name/endpoints', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeEndpointRequestSchema.parse(await c.req.json());
    const projected = await projectDocument(store, docName, 'wide', {
      operations: new Map([
        [
          operationKey(body.method, body.path),
          { method: body.method, path: body.path, spec: body.spec },
        ],
      ]),
    });
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        { error: 'invalid OpenAPI 3.1 spec', code: 'spec_invalid', issues: invalid.errors },
        400,
      );
    }
    const v = await store.proposeEndpoint(
      docName,
      body.method,
      body.path,
      body.spec,
      c.get('identity'),
      parseProposeOptions(c.req),
    );
    return c.json(v, 201);
  });

  app.get('/documents/:name/endpoints', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const endpoints = await store.listEndpoints(docName);
    return c.json({ endpoints });
  });

  app.get('/documents/:name/endpoints/:id', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const { method, path } = decodeEndpointId(c.req.param('id'));
    const versionStr = c.req.query('version');
    const wantProposed = boolQuery(c.req.query('proposed'));
    if (versionStr !== undefined) {
      const v = Number.parseInt(versionStr, 10);
      if (!Number.isFinite(v) || v < 1) return c.json({ error: 'invalid version' }, 400);
      const found = await store.getEndpointByVersion(docName, method, path, v);
      if (!found) return c.json({ error: 'not found', code: 'artifact_not_found' }, 404);
      return c.json(found);
    }
    const found = wantProposed
      ? await store.getEndpointProposed(docName, method, path)
      : await store.getEndpointCurrent(docName, method, path);
    if (!found) {
      return c.json(
        {
          error: `no ${wantProposed ? 'proposed' : 'accepted'} version`,
          code: 'artifact_not_found',
        },
        404,
      );
    }
    return c.json(found);
  });

  app.post('/documents/:name/endpoints/:id/accept', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const { method, path } = decodeEndpointId(c.req.param('id'));
    const version = await resolveEndpointTargetVersion(
      store,
      docName,
      method,
      path,
      c.req.query('version'),
    );
    const candidate = await store.getEndpointByVersion(docName, method, path, version);
    if (!candidate) {
      return c.json({ error: 'no such version', code: 'artifact_not_found' }, 404);
    }
    const projected = await projectDocument(store, docName, 'accepted', {
      operations: new Map([[operationKey(method, path), { method, path, spec: candidate.spec }]]),
    });
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        {
          error: 'accepting would leave the doc invalid',
          code: 'spec_invalid',
          issues: invalid.errors,
        },
        400,
      );
    }
    const reason = await parseOptionalAcceptBody(c);
    const v = await store.acceptEndpoint(docName, method, path, version, c.get('identity'), reason);
    return c.json(v);
  });

  app.post('/documents/:name/endpoints/:id/reject', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const { method, path } = decodeEndpointId(c.req.param('id'));
    const body = RejectArtifactRequestSchema.parse(await c.req.json());
    const version = await resolveEndpointTargetVersion(
      store,
      docName,
      method,
      path,
      c.req.query('version'),
    );
    const v = await store.rejectEndpoint(
      docName,
      method,
      path,
      version,
      body.reason,
      c.get('identity'),
    );
    return c.json(v);
  });

  app.post('/documents/:name/endpoints/:id/withdraw', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const { method, path } = decodeEndpointId(c.req.param('id'));
    const version = await resolveEndpointTargetVersion(
      store,
      docName,
      method,
      path,
      c.req.query('version'),
    );
    const v = await store.withdrawEndpoint(docName, method, path, version, c.get('identity'));
    return c.json(v);
  });

  app.get('/documents/:name/endpoints/:id/diff', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const { method, path } = decodeEndpointId(c.req.param('id'));
    const { from, to } = await resolveDiffRange(
      c.req.query('from'),
      c.req.query('to'),
      async (v) => store.getEndpointByVersion(docName, method, path, v),
      () => store.latestVersion(docName, 'operation', operationKey(method, path)),
    );
    if (!from || !to) return c.json({ error: 'not enough versions to diff' }, 404);
    const patch = generatePatch(from.spec, to.spec);
    return c.json({ fromVersion: from.version, toVersion: to.version, patch });
  });

  // --- schemas ---

  app.post('/documents/:name/schemas', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeSchemaRequestSchema.parse(await c.req.json());
    const projected = await projectDocument(store, docName, 'wide', {
      schemas: new Map([[body.name, body.spec]]),
    });
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        { error: 'invalid OpenAPI 3.1 spec', code: 'spec_invalid', issues: invalid.errors },
        400,
      );
    }
    const v = await store.proposeSchema(
      docName,
      body.name,
      body.spec,
      c.get('identity'),
      parseProposeOptions(c.req),
    );
    return c.json(v, 201);
  });

  app.get('/documents/:name/schemas', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const schemas = await store.listSchemas(docName);
    return c.json({ schemas });
  });

  app.get('/documents/:name/schemas/:schemaName', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const schemaName = SchemaNameSchema.parse(c.req.param('schemaName'));
    const versionStr = c.req.query('version');
    const wantProposed = boolQuery(c.req.query('proposed'));
    if (versionStr !== undefined) {
      const v = Number.parseInt(versionStr, 10);
      if (!Number.isFinite(v) || v < 1) return c.json({ error: 'invalid version' }, 400);
      const found = await store.getSchemaByVersion(docName, schemaName, v);
      if (!found) return c.json({ error: 'not found', code: 'artifact_not_found' }, 404);
      return c.json(found);
    }
    const found = wantProposed
      ? await store.getSchemaProposed(docName, schemaName)
      : await store.getSchemaCurrent(docName, schemaName);
    if (!found) {
      return c.json(
        {
          error: `no ${wantProposed ? 'proposed' : 'accepted'} version`,
          code: 'artifact_not_found',
        },
        404,
      );
    }
    return c.json(found);
  });

  app.post('/documents/:name/schemas/:schemaName/accept', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const schemaName = SchemaNameSchema.parse(c.req.param('schemaName'));
    const version = await resolveSchemaTargetVersion(
      store,
      docName,
      schemaName,
      c.req.query('version'),
    );
    const candidate = await store.getSchemaByVersion(docName, schemaName, version);
    if (!candidate) {
      return c.json({ error: 'no such version', code: 'artifact_not_found' }, 404);
    }
    const projected = await projectDocument(store, docName, 'accepted', {
      schemas: new Map([[schemaName, candidate.spec]]),
    });
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        {
          error: 'accepting would leave the doc invalid',
          code: 'spec_invalid',
          issues: invalid.errors,
        },
        400,
      );
    }
    const reason = await parseOptionalAcceptBody(c);
    const v = await store.acceptSchema(docName, schemaName, version, c.get('identity'), reason);
    return c.json(v);
  });

  app.post('/documents/:name/schemas/:schemaName/reject', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const schemaName = SchemaNameSchema.parse(c.req.param('schemaName'));
    const body = RejectArtifactRequestSchema.parse(await c.req.json());
    const version = await resolveSchemaTargetVersion(
      store,
      docName,
      schemaName,
      c.req.query('version'),
    );
    const v = await store.rejectSchema(
      docName,
      schemaName,
      version,
      body.reason,
      c.get('identity'),
    );
    return c.json(v);
  });

  app.post('/documents/:name/schemas/:schemaName/withdraw', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const schemaName = SchemaNameSchema.parse(c.req.param('schemaName'));
    const version = await resolveSchemaTargetVersion(
      store,
      docName,
      schemaName,
      c.req.query('version'),
    );
    const v = await store.withdrawSchema(docName, schemaName, version, c.get('identity'));
    return c.json(v);
  });

  app.get('/documents/:name/schemas/:schemaName/diff', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const schemaName = SchemaNameSchema.parse(c.req.param('schemaName'));
    const { from, to } = await resolveDiffRange(
      c.req.query('from'),
      c.req.query('to'),
      async (v) => store.getSchemaByVersion(docName, schemaName, v),
      () => store.latestVersion(docName, 'schema', schemaName),
    );
    if (!from || !to) return c.json({ error: 'not enough versions to diff' }, 404);
    const patch = generatePatch(from.spec, to.spec);
    return c.json({ fromVersion: from.version, toVersion: to.version, patch });
  });

  // --- convention (singleton per document) ---

  app.post('/documents/:name/convention', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeConventionRequestSchema.parse(await c.req.json());
    const projected = await projectDocument(store, docName, 'wide', { convention: body.spec });
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        { error: 'invalid OpenAPI 3.1 spec', code: 'spec_invalid', issues: invalid.errors },
        400,
      );
    }
    const v = await store.proposeConvention(
      docName,
      body.spec,
      c.get('identity'),
      parseProposeOptions(c.req),
    );
    return c.json(v, 201);
  });

  app.get('/documents/:name/convention', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const versionQuery = c.req.query('version');
    if (versionQuery !== undefined) {
      const version = Number.parseInt(versionQuery, 10);
      if (!Number.isFinite(version) || version < 1) {
        return c.json({ error: 'invalid version', code: 'bad_request' }, 400);
      }
      const v = await store.getConventionByVersion(docName, version);
      if (!v)
        return c.json(
          { error: `convention v${version} not found`, code: 'artifact_not_found' },
          404,
        );
      return c.json(v);
    }
    const v = await store.getConventionCurrent(docName);
    if (!v) return c.json({ error: 'no accepted convention', code: 'artifact_not_found' }, 404);
    return c.json(v);
  });

  app.get('/documents/:name/convention/proposed', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const v = await store.getConventionProposed(docName);
    if (!v) return c.json({ error: 'no proposed convention', code: 'artifact_not_found' }, 404);
    return c.json(v);
  });

  app.get('/documents/:name/convention/latest', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const v = await store.getConventionLatest(docName);
    if (!v) return c.json({ error: 'no convention', code: 'artifact_not_found' }, 404);
    return c.json(v);
  });

  app.post('/documents/:name/convention/accept', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const version = await resolveConventionTargetVersion(store, docName, c.req.query('version'));
    const candidate = await store.getConventionByVersion(docName, version);
    if (!candidate) {
      return c.json({ error: 'no such version', code: 'artifact_not_found' }, 404);
    }
    const projected = await projectDocument(store, docName, 'accepted', {
      convention: candidate.spec,
    });
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        {
          error: 'accepting would leave the doc invalid',
          code: 'spec_invalid',
          issues: invalid.errors,
        },
        400,
      );
    }
    const reason = await parseOptionalAcceptBody(c);
    const v = await store.acceptConvention(docName, version, c.get('identity'), reason);
    return c.json(v);
  });

  app.post('/documents/:name/convention/reject', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = RejectArtifactRequestSchema.parse(await c.req.json());
    const version = await resolveConventionTargetVersion(store, docName, c.req.query('version'));
    const v = await store.rejectConvention(docName, version, body.reason, c.get('identity'));
    return c.json(v);
  });

  app.post('/documents/:name/convention/withdraw', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const version = await resolveConventionTargetVersion(store, docName, c.req.query('version'));
    const v = await store.withdrawConvention(docName, version, c.get('identity'));
    return c.json(v);
  });

  app.get('/documents/:name/convention/diff', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const { from, to } = await resolveDiffRange(
      c.req.query('from'),
      c.req.query('to'),
      async (v) => store.getConventionByVersion(docName, v),
      () => store.latestVersion(docName, 'convention', 'convention'),
    );
    if (!from || !to) return c.json({ error: 'not enough versions to diff' }, 404);
    const patch = generatePatch(from.spec, to.spec);
    return c.json({ fromVersion: from.version, toVersion: to.version, patch });
  });

  // --- membership management ---
  //
  // Sock callers (peer-trust) can manage any doc's membership. TCP callers need to be
  // an owner of the doc to grant/revoke; reading the member list requires membership.

  const isOwner = async (
    c: import('hono').Context<AppEnv>,
    docName: DocumentName,
  ): Promise<boolean> => {
    if (c.get('transport') === 'sock') return true;
    const members = await store.listDocumentMembers(docName);
    return members.some((m) => m.identity === c.get('identity') && m.role === 'owner');
  };

  app.get('/documents/:name/members', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const members = await store.listDocumentMembers(docName);
    return c.json({ members });
  });

  app.post('/documents/:name/members', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    if (!(await isOwner(c, docName))) {
      return c.json({ error: 'owner-only', code: 'forbidden' }, 403);
    }
    const body = AddMemberRequestSchema.parse(await c.req.json());
    await store.addDocumentMember(docName, body.identity, body.role, c.get('identity'));
    return c.json({ ok: true }, 201);
  });

  app.delete('/documents/:name/members/:identity', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    if (!(await isOwner(c, docName))) {
      return c.json({ error: 'owner-only', code: 'forbidden' }, 403);
    }
    const target = IdentitySchema.parse(c.req.param('identity'));
    await store.removeDocumentMember(docName, target);
    return c.json({ ok: true });
  });

  // --- render routes (used by visualize CLI + browser UI) ---

  app.get('/documents/:name/openapi.yaml', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const doc = await buildOpenAPI(store, docName);
    return c.body(yamlStringify(doc), 200, { 'content-type': 'application/yaml; charset=utf-8' });
  });

  app.get('/documents/:name/openapi.json', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const doc = await buildOpenAPI(store, docName);
    return c.json(doc);
  });

  app.get('/documents/:name/rationale.json', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const rationale = await buildRationaleMap(store, docName);
    return c.json({
      endpoints: Object.fromEntries(rationale.endpoints),
      schemas: Object.fromEntries(rationale.schemas),
      convention: rationale.convention,
    });
  });

  // --- browser UI ---

  app.get('/ui', async (c) => {
    const docs = await store.listDocuments();
    const links = docs
      .map((d) => `<li><a href="/ui/${encodeURIComponent(d.name)}">${escapeHtml(d.name)}</a></li>`)
      .join('\n');
    return c.html(`<!doctype html><meta charset=utf-8><title>brackish documents</title>
<h1>brackish documents</h1>
<ul>${links || '<li>(none)</li>'}</ul>`);
  });

  app.get('/ui/:doc', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('doc'));
    const document = await buildOpenAPI(store, docName);
    const rationale = await buildRationaleMap(store, docName);
    const events = await store.listEvents(docName, 0, EVENT_PAGE_MAX);
    return c.html(renderHtml({ document, rationale, events }, { documentName: docName }));
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
    case 'version_in_flight':
    case 'version_mismatch':
      return 409;
    case 'cannot_accept_own':
    case 'cannot_reject_own':
    case 'cannot_withdraw_others':
    case 'forbidden':
      return 403;
    default:
      return 400;
  }
}

/** Strip undefined values from a batch-item options object before handing to the store
 *  (whose ProposeOptions uses exactOptionalPropertyTypes). */
function toProposeOptions(
  opts: { expectedVersion?: number | 'new' | undefined; force?: boolean | undefined } | undefined,
): import('./store/index.js').ProposeOptions {
  const out: { expectedVersion?: number | 'new'; force?: boolean } = {};
  if (!opts) return out;
  if (opts.expectedVersion !== undefined) out.expectedVersion = opts.expectedVersion;
  if (opts.force !== undefined) out.force = opts.force;
  return out;
}

/** Parse `?expected_version=` and `?force=` into the store's ProposeOptions shape. */
function parseProposeOptions(req: { query: (k: string) => string | undefined }): {
  expectedVersion?: number | 'new';
  force?: boolean;
} {
  const opts: { expectedVersion?: number | 'new'; force?: boolean } = {};
  const ev = req.query('expected_version');
  if (ev !== undefined) {
    if (ev === 'new') opts.expectedVersion = 'new';
    else {
      const n = Number.parseInt(ev, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new StoreError(
          'version_mismatch',
          `invalid expected_version "${ev}" (expected positive integer or "new")`,
        );
      }
      opts.expectedVersion = n;
    }
  }
  if (req.query('force') === 'true') opts.force = true;
  return opts;
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

function parseTail(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new HttpError(400, 'invalid "tail" count');
  }
  return Math.min(n, EVENT_PAGE_MAX);
}

function clampTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return WAIT_TIMEOUT_DEFAULT_S;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return WAIT_TIMEOUT_DEFAULT_S;
  return Math.min(Math.max(n, WAIT_TIMEOUT_MIN_S), WAIT_TIMEOUT_MAX_S);
}

function decodeEndpointId(rawId: string): { method: HttpMethod; path: string } {
  return parseOperationIdentityKey(decodeURIComponent(rawId));
}

function boolQuery(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** Parse the optional `{reason}` accept body. Accept requests historically have no body;
 *  callers passing `--rationale` will send one. Missing/empty body → `undefined`. */
async function parseOptionalAcceptBody(c: {
  req: { json: () => Promise<unknown>; header: (n: string) => string | undefined };
}): Promise<string | undefined> {
  const len = c.req.header('content-length');
  if (len === undefined || len === '0') return undefined;
  const body = AcceptArtifactRequestSchema.parse(await c.req.json());
  return body.reason;
}

async function resolveEndpointTargetVersion(
  store: Store,
  docName: DocumentName,
  method: HttpMethod,
  path: string,
  raw: string | undefined,
): Promise<number> {
  if (raw !== undefined) {
    const v = Number.parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 1) throw new HttpError(400, 'invalid version');
    return v;
  }
  const proposed = await store.getEndpointProposed(docName, method, path);
  if (!proposed)
    throw new StoreError(
      'artifact_not_found',
      `no proposed version of endpoint ${method} ${path} to act on`,
    );
  return proposed.version;
}

async function resolveSchemaTargetVersion(
  store: Store,
  docName: DocumentName,
  name: string,
  raw: string | undefined,
): Promise<number> {
  if (raw !== undefined) {
    const v = Number.parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 1) throw new HttpError(400, 'invalid version');
    return v;
  }
  const proposed = await store.getSchemaProposed(docName, name);
  if (!proposed)
    throw new StoreError('artifact_not_found', `no proposed version of schema ${name} to act on`);
  return proposed.version;
}

async function resolveConventionTargetVersion(
  store: Store,
  docName: DocumentName,
  raw: string | undefined,
): Promise<number> {
  if (raw !== undefined) {
    const v = Number.parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 1) throw new HttpError(400, 'invalid version');
    return v;
  }
  const proposed = await store.getConventionProposed(docName);
  if (!proposed)
    throw new StoreError('artifact_not_found', 'no proposed version of convention to act on');
  return proposed.version;
}

type VersionedSpec = { version: number; spec: unknown };

async function resolveDiffRange<T extends VersionedSpec | null>(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  fetchByVersion: (v: number) => Promise<T>,
  latestVersion: () => Promise<number | null>,
): Promise<{ from: VersionedSpec | null; to: VersionedSpec | null }> {
  // Defaults: --to is the latest existing version; --from is to-1 if not given.
  const toV = toRaw !== undefined ? Number.parseInt(toRaw, 10) : NaN;
  const fromV = fromRaw !== undefined ? Number.parseInt(fromRaw, 10) : NaN;

  let to: VersionedSpec | null = null;
  if (Number.isFinite(toV) && toV >= 1) {
    const v = await fetchByVersion(toV);
    if (v) to = { version: v.version, spec: v.spec };
  } else {
    const max = await latestVersion();
    if (max !== null) {
      const v = await fetchByVersion(max);
      if (v) to = { version: v.version, spec: v.spec };
    }
  }
  if (!to) return { from: null, to: null };
  const targetFrom = Number.isFinite(fromV) && fromV >= 1 ? fromV : to.version - 1;
  if (targetFrom < 1) return { from: null, to };
  const fromV2 = await fetchByVersion(targetFrom);
  return {
    from: fromV2 ? { version: fromV2.version, spec: fromV2.spec } : null,
    to,
  };
}

/** The doc that `brackish visualize` renders is the same doc the propose/accept validation
 *  runs against (with `view='accepted'` and no overlay) — single code path, no drift. */
async function buildOpenAPI(
  store: Store,
  docName: DocumentName,
): Promise<ReturnType<typeof assembleDocument>> {
  return projectDocument(store, docName, 'accepted');
}

async function buildRationaleMap(store: Store, docName: DocumentName): Promise<RationaleMap> {
  const endpoints = new Map<string, Awaited<ReturnType<Store['rationaleForEndpoint']>>>();
  const schemas = new Map<string, Awaited<ReturnType<Store['rationaleForSchema']>>>();
  const epSummaries = await store.listEndpoints(docName);
  for (const s of epSummaries) {
    const r = await store.rationaleForEndpoint(docName, s.method, s.path);
    if (r.length > 0) endpoints.set(`${s.method.toUpperCase()} ${s.path}`, r);
  }
  const schemaSummaries = await store.listSchemas(docName);
  for (const s of schemaSummaries) {
    const r = await store.rationaleForSchema(docName, s.name);
    if (r.length > 0) schemas.set(s.name, r);
  }
  const convention = await store.rationaleForConvention(docName);
  return { endpoints, schemas, convention };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    const m: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    };
    return m[c] ?? c;
  });
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

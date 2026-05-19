// Hono app + dual-bind serve. Unix socket is always bound (peer-trust auth via
// X-Brackish-Identity header); TCP is bound additionally when ServerConfig.bind is set
// (bearer-token auth via Authorization: Bearer).

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { stringify as yamlStringify } from 'yaml';
import { type AppBindings, type AppVariables, makeAuthMiddleware } from './auth.js';
import { ensureBrackishHome, parseBindAddress, type ServerConfig } from './config.js';
import { generatePatch } from './diff.js';
import {
  CreateDocumentRequestSchema,
  CreateInviteRequestSchema,
  type Cursor,
  type DocumentName,
  DocumentNameSchema,
  type Event,
  type HttpMethod,
  IdentitySchema,
  ProposeConventionRequestSchema,
  ProposeEndpointRequestSchema,
  ProposeSchemaRequestSchema,
  parseOperationIdentityKey,
  RedeemInviteRequestSchema,
  RejectArtifactRequestSchema,
  SchemaNameSchema,
  SendMessageRequestSchema,
} from './models.js';
import { EventNotifier } from './notifier.js';
import { assembleDocument } from './openapi.js';
import { type RationaleMap, renderHtml } from './render.js';
import type { Store } from './store/index.js';
import { SqliteStore, StoreError } from './store/sqlite.js';

const SERVER_VERSION = '0.3.0';

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

  // --- endpoints (operation artifacts) ---

  app.post('/documents/:name/endpoints', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeEndpointRequestSchema.parse(await c.req.json());
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
    const v = await store.acceptEndpoint(docName, method, path, version, c.get('identity'));
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
    const { from, to } = await resolveDiffRange(c.req.query('from'), c.req.query('to'), async (v) =>
      store.getEndpointByVersion(docName, method, path, v),
    );
    if (!from || !to) return c.json({ error: 'not enough versions to diff' }, 404);
    const patch = generatePatch(from.spec, to.spec);
    return c.json({ fromVersion: from.version, toVersion: to.version, patch });
  });

  // --- schemas ---

  app.post('/documents/:name/schemas', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeSchemaRequestSchema.parse(await c.req.json());
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
    const v = await store.acceptSchema(docName, schemaName, version, c.get('identity'));
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
    const { from, to } = await resolveDiffRange(c.req.query('from'), c.req.query('to'), async (v) =>
      store.getSchemaByVersion(docName, schemaName, v),
    );
    if (!from || !to) return c.json({ error: 'not enough versions to diff' }, 404);
    const patch = generatePatch(from.spec, to.spec);
    return c.json({ fromVersion: from.version, toVersion: to.version, patch });
  });

  // --- convention (singleton per document) ---

  app.post('/documents/:name/convention', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = ProposeConventionRequestSchema.parse(await c.req.json());
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

  app.post('/documents/:name/convention/accept', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const version = await resolveConventionTargetVersion(store, docName, c.req.query('version'));
    const v = await store.acceptConvention(docName, version, c.get('identity'));
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
    const { from, to } = await resolveDiffRange(c.req.query('from'), c.req.query('to'), async (v) =>
      store.getConventionByVersion(docName, v),
    );
    if (!from || !to) return c.json({ error: 'not enough versions to diff' }, 404);
    const patch = generatePatch(from.spec, to.spec);
    return c.json({ fromVersion: from.version, toVersion: to.version, patch });
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
    return c.html(renderHtml({ document, rationale }, { documentName: docName }));
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
      return 403;
    default:
      return 400;
  }
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
): Promise<{ from: VersionedSpec | null; to: VersionedSpec | null }> {
  // Defaults: --to is the latest existing version; --from is to-1 if not given.
  const toV = toRaw !== undefined ? Number.parseInt(toRaw, 10) : NaN;
  const fromV = fromRaw !== undefined ? Number.parseInt(fromRaw, 10) : NaN;

  let to: VersionedSpec | null = null;
  if (Number.isFinite(toV) && toV >= 1) {
    const v = await fetchByVersion(toV);
    if (v) to = { version: v.version, spec: v.spec };
  } else {
    // Walk down from a high version until we find one. For typical use the agent will pass --to.
    for (let v = 50; v >= 1; v--) {
      const found = await fetchByVersion(v);
      if (found) {
        to = { version: found.version, spec: found.spec };
        break;
      }
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

async function buildOpenAPI(
  store: Store,
  docName: DocumentName,
): Promise<ReturnType<typeof assembleDocument>> {
  const [endpoints, schemas, convention] = await Promise.all([
    collectAcceptedEndpoints(store, docName),
    collectAcceptedSchemas(store, docName),
    store.getConventionCurrent(docName),
  ]);
  return assembleDocument({ operations: endpoints, schemas, convention });
}

async function collectAcceptedEndpoints(
  store: Store,
  docName: DocumentName,
): Promise<Array<NonNullable<Awaited<ReturnType<Store['getEndpointCurrent']>>>>> {
  const summaries = await store.listEndpoints(docName);
  const result: Array<NonNullable<Awaited<ReturnType<Store['getEndpointCurrent']>>>> = [];
  for (const s of summaries) {
    if (s.currentVersion === null) continue;
    const v = await store.getEndpointCurrent(docName, s.method, s.path);
    if (v) result.push(v);
  }
  return result;
}

async function collectAcceptedSchemas(
  store: Store,
  docName: DocumentName,
): Promise<Array<NonNullable<Awaited<ReturnType<Store['getSchemaCurrent']>>>>> {
  const summaries = await store.listSchemas(docName);
  const result: Array<NonNullable<Awaited<ReturnType<Store['getSchemaCurrent']>>>> = [];
  for (const s of summaries) {
    if (s.currentVersion === null) continue;
    const v = await store.getSchemaCurrent(docName, s.name);
    if (v) result.push(v);
  }
  return result;
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

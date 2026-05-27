// Hono app + dual-bind serve. Unix socket is always bound (peer-trust auth via
// X-Brackish-Identity header); TCP is bound additionally when ServerConfig.bind is set
// (bearer-token auth via Authorization: Bearer).

import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { stringify as yamlStringify } from 'yaml';
import { ZodError } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { ensureBrackishHome, parseBindAddress, type ServerConfig } from '../io/config.js';
import { generatePatch } from '../lib/diff.js';
import type { LintIssue } from '../lib/lint-types.js';
import {
  AcceptArtifactRequestSchema,
  AcceptBatchRequestSchema,
  AddMemberRequestSchema,
  CounterRequestSchema,
  CreateDocumentRequestSchema,
  CreateInviteRequestSchema,
  type Cursor,
  type DocumentName,
  DocumentNameSchema,
  type Event,
  type HttpMethod,
  IdentitySchema,
  operationIdentityKey,
  ProposeBatchRequestSchema,
  ProposeConventionRequestSchema,
  ProposeEndpointRequestSchema,
  ProposeSchemaRequestSchema,
  parseOperationIdentityKey,
  RedeemInviteRequestSchema,
  RejectArtifactRequestSchema,
  type RetractionTarget,
  type RetractRequest,
  RetractRequestSchema,
  SchemaNameSchema,
  SendMessageRequestSchema,
  type ValidateRequest,
  ValidateRequestSchema,
} from '../lib/models.js';
import { EventNotifier } from '../lib/notifier.js';
import type { assembleDocument } from '../lib/openapi.js';
import { certFingerprint } from '../lib/tls.js';
import { validateDocument } from '../lib/validate.js';
import { type RationaleMap, renderHtml } from '../render/render.js';
import { type AppBindings, type AppVariables, makeAuthMiddleware } from './auth.js';
import { RateLimiter } from './limiter.js';
import { type Overlay, operationKey, projectDocument } from './projection.js';
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

type BuildAppOptions = {
  store: Store;
  notifier: EventNotifier;
};

/** Build the Hono app — the in-process core that `startServer` binds to a socket/TCP. */
function buildApp(opts: BuildAppOptions): Hono<AppEnv> {
  const { store, notifier } = opts;
  const app = new Hono<AppEnv>();

  // TCP-only rate limiters. Socket callers bypass each one (peer-trust + the
  // filesystem permission on the socket already gate access). Keys are source IP.
  const connectLimiter = new RateLimiter({ burst: 10, windowSeconds: 60 });
  const failedAuthLimiter = new RateLimiter({ burst: 20, windowSeconds: 60 });

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
      return c.json({ error: `document "${docName}" not found`, code: 'document_not_found' }, 404);
    }
    const ok = await store.isMember(docName, c.get('identity'));
    if (!ok) {
      return c.json({ error: `not a member of "${docName}"`, code: 'forbidden' }, 403);
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

  // --- authenticated routes ---

  const authMiddleware = makeAuthMiddleware(store, { failedAuthLimiter });
  const auth = app.use('*', async (c, next) => {
    // /healthz and /connect are public; skip auth for them. Browser UI access at
    // /ui/* is handled inside the auth middleware itself (public on loopback TCP).
    const path = new URL(c.req.url).pathname;
    if (path === '/healthz' || path === '/connect') return next();
    return authMiddleware(c, next);
  });
  void auth;

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

  // Deliver the caller's held events — make this turn's moves visible to the peer as one batch.
  app.post('/documents/:name/deliver', async (c) => {
    const name = DocumentNameSchema.parse(c.req.param('name'));
    const delivered = await store.deliver(name, c.get('identity'));
    return c.json({ delivered });
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

  // Read-only: the caller's own held (undelivered) moves, grouped by doc — drives the
  // "you have undelivered moves" reminder.
  app.get('/held', async (c) => {
    const held = await store.heldByDoc(c.get('identity'));
    return c.json({ held });
  });

  // --- dry-run validation ---
  //
  // Read-only. Assembles the doc exactly as propose-batch would (accepted + proposed + this
  // overlay, the 'wide' view) and runs the meta-schema validator, but commits nothing — no
  // artifact rows, no events. An empty body validates the current accepted doc as-is. Lets a
  // caller preview "would this set leave the doc valid?" without the destructive probing of
  // actually proposing things to find out.
  app.post('/documents/:name/validate', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body: ValidateRequest = ValidateRequestSchema.parse(await c.req.json());
    const { overlay, hasOverlay } = buildOverlay(body);
    const view = hasOverlay ? 'wide' : 'accepted';
    const projected = await projectDocument(store, docName, view, overlay);
    const result = await validateDocument(projected);
    return c.json({ valid: result.errors.length === 0, view, issues: result.errors });
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

    const { overlay } = buildOverlay(body);
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

  // --- atomic batch accept ---
  //
  // The peer accepts a coordinated set of proposed artifacts at once. Resolves each target's latest
  // proposed version, overlays them ALL onto the accepted doc, meta-schema-validates the whole once,
  // then commits all-or-nothing via Store.batchAccept. So a mutually-referencing set accepts together
  // (the per-item accept route would reject the first for a dangling $ref), and a set that would
  // wedge the accepted doc is refused whole. Symmetric with propose-batch, in the accept direction.
  app.post('/documents/:name/accept-batch', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = AcceptBatchRequestSchema.parse(await c.req.json());

    const overlay: Overlay = {};
    const input: import('./store/index.js').BatchAcceptInput = {};

    if (body.schemas && body.schemas.length > 0) {
      overlay.schemas = new Map();
      input.schemas = [];
      for (const name of body.schemas) {
        const version = await resolveSchemaTargetVersion(store, docName, name, undefined);
        const candidate = await store.getSchemaByVersion(docName, name, version);
        if (!candidate)
          return c.json({ error: 'no such version', code: 'artifact_not_found' }, 404);
        overlay.schemas.set(name, candidate.spec);
        input.schemas.push({ name, version });
      }
    }
    if (body.endpoints && body.endpoints.length > 0) {
      overlay.operations = new Map();
      input.endpoints = [];
      for (const e of body.endpoints) {
        const version = await resolveEndpointTargetVersion(
          store,
          docName,
          e.method,
          e.path,
          undefined,
        );
        const candidate = await store.getEndpointByVersion(docName, e.method, e.path, version);
        if (!candidate)
          return c.json({ error: 'no such version', code: 'artifact_not_found' }, 404);
        overlay.operations.set(operationKey(e.method, e.path), {
          method: e.method,
          path: e.path,
          spec: candidate.spec,
        });
        input.endpoints.push({ method: e.method, path: e.path, version });
      }
    }

    // --include-dependencies: expand the batch to the transitive $ref-closure of still-PROPOSED
    // schemas the named targets reference, so accepting an endpoint also accepts the schemas it needs
    // (in one atomic batch). Already-accepted refs are left alone; refs that aren't even proposed are
    // left for validation to flag.
    if (body.includeDependencies) {
      overlay.schemas ??= new Map();
      input.schemas ??= [];
      const inBatch = new Set<string>(input.schemas.map((s) => s.name));
      const queue: unknown[] = [
        ...overlay.schemas.values(),
        ...(overlay.operations ? [...overlay.operations.values()].map((o) => o.spec) : []),
      ];
      while (queue.length > 0) {
        const refs = new Set<string>();
        collectSchemaRefs(queue.shift(), refs);
        for (const name of refs) {
          if (inBatch.has(name)) continue;
          inBatch.add(name);
          if (await store.getSchemaCurrent(docName, name)) continue; // already in the accepted doc
          const proposed = await store.getSchemaProposed(docName, name);
          if (!proposed) continue; // not proposed → genuinely missing; validation will catch it
          overlay.schemas.set(name, proposed.spec);
          input.schemas.push({ name, version: proposed.version });
          queue.push(proposed.spec);
        }
      }
    }

    const projected = await projectDocument(store, docName, 'accepted', overlay);
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) return acceptInvalidResponse(c, store, docName, invalid.errors);

    const namedSchemas = new Set<string>(body.schemas ?? []);
    try {
      const result = await store.batchAccept(docName, input, c.get('identity'), body.rationale);
      // Partition: the artifacts the caller named vs the schemas --include-dependencies pulled in.
      const accepted: typeof result = [];
      const dependencies: typeof result = [];
      for (const item of result) {
        if (item.kind === 'schema' && !namedSchemas.has(item.name)) dependencies.push(item);
        else accepted.push(item);
      }
      return c.json({ accepted, dependencies });
    } catch (err) {
      // The whole batch rolled back — no partial state to report (mirrors propose-batch).
      const status = err instanceof StoreError ? storeErrorStatus(err.code) : 500;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof StoreError ? err.code : null;
      return c.json({ error: message, code }, status);
    }
  });

  // --- counter (atomic reject-current + propose-replacement) ---
  //
  // One discriminated route for all three nouns. Validates the replacement against the assembled
  // doc exactly as propose does, then commits the reject+propose atomically via Store.counter*.
  // StoreError (artifact_not_pending / cannot_reject_own / version_mismatch) propagates to onError.
  app.post('/documents/:name/counter', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = CounterRequestSchema.parse(await c.req.json());
    const identity = c.get('identity');

    const overlay: Overlay =
      body.kind === 'endpoint'
        ? {
            operations: new Map([
              [
                operationKey(body.method, body.path),
                { method: body.method, path: body.path, spec: body.spec },
              ],
            ]),
          }
        : body.kind === 'schema'
          ? { schemas: new Map([[body.name, body.spec]]) }
          : { convention: body.spec };
    const projected = await projectDocument(store, docName, 'wide', overlay);
    const invalid = await validateDocument(projected);
    if (invalid.errors.length > 0) {
      return c.json(
        { error: 'invalid OpenAPI 3.1 spec', code: 'spec_invalid', issues: invalid.errors },
        400,
      );
    }

    const opts = toProposeOptions(body.options);
    if (body.kind === 'endpoint') {
      const v = await store.counterEndpoint(
        docName,
        body.method,
        body.path,
        body.spec,
        identity,
        body.reason,
        opts,
      );
      return c.json({ kind: 'endpoint', envelope: v }, 201);
    }
    if (body.kind === 'schema') {
      const v = await store.counterSchema(
        docName,
        body.name,
        body.spec,
        identity,
        body.reason,
        opts,
      );
      return c.json({ kind: 'schema', envelope: v }, 201);
    }
    const v = await store.counterConvention(docName, body.spec, identity, body.reason, opts);
    return c.json({ kind: 'convention', envelope: v }, 201);
  });

  // --- retractions (negotiated, grouped removals) ---
  //
  // A retraction proposes removing a coordinated set of accepted artifacts. The peer accepts
  // (the set is tombstoned atomically, after validating the post-removal doc is still fully
  // valid — no orphaned $ref) or rejects (nothing changes). Symmetric with propose/accept:
  // nothing leaves the contract without both sides. The artifacts stay live while pending.
  app.post('/documents/:name/retractions', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const body = RetractRequestSchema.parse(await c.req.json());
    const targets = targetsFromRetractRequest(body);
    // Preview: would removing these leave the doc invalid? (binding re-check is at accept.)
    const invalid = await validateDocument(
      await projectDocument(store, docName, 'accepted', overlayForTargets(targets)),
    );
    if (invalid.errors.length > 0) {
      return c.json(
        {
          error: 'retracting these would leave the doc invalid',
          code: 'spec_invalid',
          issues: invalid.errors,
        },
        400,
      );
    }
    const retraction = await store.proposeRetraction(
      docName,
      targets,
      c.get('identity'),
      body.reason,
    );
    return c.json({ retraction }, 201);
  });

  app.get('/documents/:name/retractions', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const statusQ = c.req.query('status');
    const opts: { status?: 'proposed' | 'accepted' | 'rejected' | 'withdrawn' } = {};
    if (
      statusQ === 'proposed' ||
      statusQ === 'accepted' ||
      statusQ === 'rejected' ||
      statusQ === 'withdrawn'
    ) {
      opts.status = statusQ;
    }
    const retractions = await store.listRetractions(docName, opts);
    return c.json({ retractions });
  });

  app.get('/documents/:name/retractions/:id', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const id = parseRetractionId(c.req.param('id'));
    const retraction = await store.getRetraction(docName, id);
    if (!retraction) return c.json({ error: 'not found', code: 'artifact_not_found' }, 404);
    return c.json({ retraction });
  });

  app.post('/documents/:name/retractions/:id/accept', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const id = parseRetractionId(c.req.param('id'));
    const retraction = await store.getRetraction(docName, id);
    if (!retraction) return c.json({ error: 'not found', code: 'artifact_not_found' }, 404);
    // Binding fully-valid-after gate: assemble the accepted doc with this set removed.
    const invalid = await validateDocument(
      await projectDocument(store, docName, 'accepted', overlayForTargets(retraction.targets)),
    );
    if (invalid.errors.length > 0) {
      return c.json(
        {
          error: 'accepting this retraction would leave the doc invalid',
          code: 'spec_invalid',
          issues: invalid.errors,
        },
        400,
      );
    }
    const v = await store.acceptRetraction(docName, id, c.get('identity'));
    return c.json({ retraction: v });
  });

  app.post('/documents/:name/retractions/:id/reject', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const id = parseRetractionId(c.req.param('id'));
    const body = RejectArtifactRequestSchema.parse(await c.req.json());
    const v = await store.rejectRetraction(docName, id, body.reason, c.get('identity'));
    return c.json({ retraction: v });
  });

  app.post('/documents/:name/retractions/:id/withdraw', async (c) => {
    const docName = DocumentNameSchema.parse(c.req.param('name'));
    const id = parseRetractionId(c.req.param('id'));
    const v = await store.withdrawRetraction(docName, id, c.get('identity'));
    return c.json({ retraction: v });
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
    if (invalid.errors.length > 0) return acceptInvalidResponse(c, store, docName, invalid.errors);
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
      // `operationIdentityKey` (uppercase method) is the store's keying scheme — must match
      // the keys used by every other endpoint store call. The projection's `operationKey`
      // is lowercase and applies only to projection-internal overlay maps.
      () => store.latestVersion(docName, 'operation', operationIdentityKey(method, path)),
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
    if (invalid.errors.length > 0) return acceptInvalidResponse(c, store, docName, invalid.errors);
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
    if (invalid.errors.length > 0) return acceptInvalidResponse(c, store, docName, invalid.errors);
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

/** Walk a spec (object/array) collecting the name X of every `#/components/schemas/X` $ref. Drives
 *  the --include-dependencies expansion: which schemas an accepted artifact transitively requires. */
function collectSchemaRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const x of node) collectSchemaRefs(x, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = v.match(/^#\/components\/schemas\/([A-Za-z][A-Za-z0-9_]*)$/);
        if (m?.[1] !== undefined) out.add(m[1]);
      } else {
        collectSchemaRefs(v, out);
      }
    }
  }
}

/** Build the 400 response for an accept that would invalidate the doc. If the cause is dangling
 *  `$ref`(s) to schema(s) that are merely PROPOSED-not-yet-accepted (the accept-ordering footgun),
 *  name them and point at accepting those first — the generic `spec_invalid` advice (validate /
 *  propose retraction) is for the propose path and misleads on accept. Falls back to that generic
 *  message for any other validation failure. */
async function acceptInvalidResponse(
  c: import('hono').Context<AppEnv>,
  store: Store,
  docName: DocumentName,
  issues: LintIssue[],
): Promise<Response> {
  const refNames = new Set<string>();
  for (const issue of issues) {
    for (const m of issue.message.matchAll(/#\/components\/schemas\/([A-Za-z0-9_.-]+)/g)) {
      if (m[1] !== undefined) refNames.add(m[1]);
    }
  }
  const orphans: string[] = [];
  for (const name of refNames) {
    if (await store.getSchemaCurrent(docName, name)) continue; // already accepted ⇒ not the cause
    if (await store.getSchemaProposed(docName, name)) orphans.push(name);
  }
  if (orphans.length === 0) {
    return c.json(
      { error: 'accepting would leave the doc invalid', code: 'spec_invalid', issues },
      400,
    );
  }
  const targets = orphans.map((n) => `--target ${n}`).join(' ');
  return c.json(
    {
      error:
        `accepting would orphan a $ref: this references schema(s) ${orphans.join(', ')}, which are ` +
        `proposed but not yet accepted. Accept those first — \`brackish accept schema ${targets}\` — then retry.`,
      code: 'accept_orphans_ref',
      issues,
    },
    400,
  );
}

/** Turn a validate/propose-batch request body into a projection Overlay. `hasOverlay` is false
 *  only for an empty body (nothing to overlay → validate the current doc). Shared by the
 *  validate and propose-batch routes so both assemble identically. */
function buildOverlay(body: ValidateRequest): { overlay: Overlay; hasOverlay: boolean } {
  const overlay: Overlay = {};
  let hasOverlay = false;
  if (body.convention) {
    overlay.convention = body.convention.spec;
    hasOverlay = true;
  }
  if (body.schemas && body.schemas.length > 0) {
    overlay.schemas = new Map();
    for (const s of body.schemas) overlay.schemas.set(s.name, s.spec);
    hasOverlay = true;
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
    hasOverlay = true;
  }
  return { overlay, hasOverlay };
}

/** Normalize a retract request body ({endpoints, schemas, convention}) into RetractionTargets. */
function targetsFromRetractRequest(body: RetractRequest): RetractionTarget[] {
  const targets: RetractionTarget[] = [];
  for (const e of body.endpoints ?? [])
    targets.push({ kind: 'endpoint', method: e.method, path: e.path });
  for (const n of body.schemas ?? []) targets.push({ kind: 'schema', name: n });
  if (body.convention) targets.push({ kind: 'convention' });
  return targets;
}

/** A projection Overlay that removes the retraction's targets — used to validate fully-valid-after. */
function overlayForTargets(targets: RetractionTarget[]): Overlay {
  const removeOperations = new Set<string>();
  const removeSchemas = new Set<string>();
  let removeConvention = false;
  for (const t of targets) {
    if (t.kind === 'endpoint') removeOperations.add(operationKey(t.method, t.path));
    else if (t.kind === 'schema') removeSchemas.add(t.name);
    else removeConvention = true;
  }
  const overlay: Overlay = { removeOperations, removeSchemas };
  if (removeConvention) overlay.removeConvention = true;
  return overlay;
}

function parseRetractionId(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'invalid retraction id');
  return n;
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

class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
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
  // 'https' when the TCP bind serves TLS (cert+key configured), else 'http'. Meaningful only
  // when tcpAddress is non-null. tlsFingerprint is the cert's pin, for the invite/connect line.
  tcpScheme: 'http' | 'https';
  tlsFingerprint: string | null;
  close(): Promise<void>;
};

export async function startServer(opts: { config: ServerConfig }): Promise<RunningServer> {
  ensureBrackishHome();
  const notifier = new EventNotifier();
  const store = new SqliteStore({ path: opts.config.dataPath, notifier });
  const app = buildApp({ store, notifier });
  const listener = getRequestListener(app.fetch);

  // BYO TLS for the TCP bind only — both cert+key required, and only meaningful with a bind.
  // The Unix socket always stays plain HTTP (filesystem-gated; TLS there is pointless).
  const { tlsCert, tlsKey } = opts.config;
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw new Error('TLS requires both tlsCert and tlsKey (got only one)');
  }
  let tlsOptions: { cert: string; key: string } | undefined;
  let tlsFingerprint: string | null = null;
  if (tlsCert !== undefined && tlsKey !== undefined) {
    if (opts.config.bind === undefined) {
      throw new Error('TLS (tlsCert/tlsKey) requires a TCP bind');
    }
    const cert = readFileSync(tlsCert, 'utf8');
    tlsOptions = { cert, key: readFileSync(tlsKey, 'utf8') };
    tlsFingerprint = certFingerprint(cert);
  }

  if (existsSync(opts.config.socketPath)) {
    unlinkSync(opts.config.socketPath);
  }

  const socketServer = createServer(listener);
  await listenAsync(socketServer, { path: opts.config.socketPath });
  chmodSync(opts.config.socketPath, 0o600);

  let tcpServer: HttpServer | HttpsServer | undefined;
  let tcpAddress: { host: string; port: number } | null = null;
  if (opts.config.bind !== undefined) {
    const { host, port } = parseBindAddress(opts.config.bind);
    tcpServer = tlsOptions ? createHttpsServer(tlsOptions, listener) : createServer(listener);
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
    tcpScheme: tlsOptions ? 'https' : 'http',
    tlsFingerprint,
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

function listenAsync(server: HttpServer | HttpsServer, opts: ListenOptions): Promise<void> {
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

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

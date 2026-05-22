import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Response as UndiciResponse, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/daemon/server.js';

describe('server (Unix-socket transport)', () => {
  let tmp: string;
  let server: RunningServer;
  let sockAgent: Agent;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-srv-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    sockAgent = new Agent({ connect: { socketPath: server.socketPath } });
  });

  afterEach(async () => {
    await server.close();
    await sockAgent.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    opts: { identity?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<UndiciResponse> => {
    const headers: Record<string, string> = {
      'X-Brackish-Identity': opts.identity ?? 'host',
      ...opts.headers,
    };
    const init: Parameters<typeof undiciFetch>[1] = { method, headers, dispatcher: sockAgent };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    return undiciFetch(`http://localhost${path}`, init);
  };

  describe('public + auth', () => {
    it('healthz is reachable with no identity header', async () => {
      const res = await undiciFetch('http://localhost/healthz', { dispatcher: sockAgent });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; version: string };
      expect(data.ok).toBe(true);
    });

    it('socket transport rejects missing X-Brackish-Identity', async () => {
      const res = await undiciFetch('http://localhost/whoami', { dispatcher: sockAgent });
      expect(res.status).toBe(401);
    });

    it('socket transport rejects malformed identity', async () => {
      const res = await call('GET', '/whoami', { identity: 'NOT-VALID' });
      expect(res.status).toBe(401);
    });

    it('whoami returns the supplied identity', async () => {
      const res = await call('GET', '/whoami', { identity: 'frontend' });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { identity: string; serverVersion: string };
      expect(data.identity).toBe('frontend');
    });
  });

  describe('documents', () => {
    it('create + list + get', async () => {
      const cr = await call('POST', '/documents', { body: { name: 'contracts' } });
      expect(cr.status).toBe(201);

      const list = await call('GET', '/documents');
      const data = (await list.json()) as { documents: { name: string }[] };
      expect(data.documents.map((t) => t.name)).toContain('contracts');

      const get = await call('GET', '/documents/contracts');
      expect(get.status).toBe(200);
    });

    it('duplicate create returns 409', async () => {
      await call('POST', '/documents', { body: { name: 'dup' } });
      const res = await call('POST', '/documents', { body: { name: 'dup' } });
      expect(res.status).toBe(409);
    });

    it('get unknown document returns 404', async () => {
      const res = await call('GET', '/documents/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('messages, events, cursor', () => {
    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 't' } });
    });

    it('send + list events from cursor 0', async () => {
      await call('POST', '/documents/t/messages', { body: { text: 'hello' } });
      const res = await call('GET', '/documents/t/events?since=0');
      expect(res.status).toBe(200);
      const data = (await res.json()) as { events: { kind: string }[]; cursor: number };
      expect(data.events.length).toBeGreaterThanOrEqual(2); // document_created + message
      expect(data.cursor).toBeGreaterThan(0);
    });

    it('list events advances server-tracked cursor', async () => {
      await call('POST', '/documents/t/messages', { body: { text: 'one' } });
      const r1 = (await (await call('GET', '/documents/t/events?since=0')).json()) as {
        cursor: number;
      };
      // A subsequent wait with no since uses last-seen cursor; should not return the
      // already-read events as fresh.
      const r2 = (await (await call('GET', '/documents/t/wait?timeout=1')).json()) as {
        events: unknown[];
        cursor: number;
      };
      expect(r2.events).toEqual([]);
      expect(r2.cursor).toBe(r1.cursor);
    });

    it('explicit since=N overrides server-tracked cursor', async () => {
      await call('POST', '/documents/t/messages', { body: { text: 'one' } });
      const r = (await (await call('GET', '/documents/t/events?since=0')).json()) as {
        events: unknown[];
        cursor: number;
      };
      // re-read from 0 — should see them again
      const reread = (await (await call('GET', '/documents/t/events?since=0')).json()) as {
        events: unknown[];
      };
      expect(reread.events.length).toBe(r.events.length);
    });

    it('--tail returns the last N events without advancing the cursor', async () => {
      for (let i = 0; i < 5; i++) {
        await call('POST', '/documents/t/messages', { body: { text: `m${i}` } });
      }
      const cursorBefore = (
        (await (await call('GET', '/documents/t/events?tail=2')).json()) as { cursor: number }
      ).cursor;
      const tailRes = (await (await call('GET', '/documents/t/events?tail=2')).json()) as {
        events: { kind: string }[];
        cursor: number;
      };
      expect(tailRes.events).toHaveLength(2);
      // Cursor is unchanged — a follow-up wait with no since still sees nothing.
      const wait = (await (await call('GET', '/documents/t/wait?timeout=1')).json()) as {
        events: unknown[];
      };
      // wait may return everything since cursor=0 was never advanced (no prior read). Either way,
      // tail itself didn't change the cursor:
      expect(tailRes.cursor).toBe(cursorBefore);
      // wait result confirms tail didn't advance — events count would be 0 if tail HAD advanced.
      expect(wait.events.length).toBeGreaterThan(0);
    });
  });

  describe('error mapping', () => {
    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 't' } });
    });

    it('returns 400 (not 500) when a query param fails HttpError validation', async () => {
      // `since=abc` triggers HttpError(400) inside parseSince. Currently that error
      // class isn't caught by app.onError, so the handler falls through to the generic
      // 500 path — the targeted bug.
      const res = await call('GET', '/documents/t/events?since=abc');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('since');
    });

    it('returns 400 (not 500) when a request body fails zod validation', async () => {
      // Empty message text fails SendMessageRequestSchema (min(1)). The ZodError isn't
      // a StoreError, so the current code returns 500.
      const res = await call('POST', '/documents/t/messages', { body: { text: '' } });
      expect(res.status).toBe(400);
    });

    it('returns 400 (not 500) when a path param fails identity validation', async () => {
      const res = await call('GET', '/documents/NOT-VALID');
      expect(res.status).toBe(400);
    });
  });

  describe('long-poll wait', () => {
    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 't' } });
      // drain initial document_created event for "host" identity by reading once
      await call('GET', '/documents/t/events');
    });

    it('times out cleanly when nothing arrives', async () => {
      const t0 = Date.now();
      const res = await call('GET', '/documents/t/wait?timeout=1');
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      const data = (await res.json()) as { events: unknown[]; cursor: number };
      expect(data.events).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2500);
    });

    it('wakes the moment a new message arrives from another identity', async () => {
      const t0 = Date.now();
      const waitPromise = call('GET', '/documents/t/wait?timeout=10');
      // Send a message ~150ms later as a different identity.
      const sendPromise = (async () => {
        await new Promise((r) => setTimeout(r, 150));
        await call('POST', '/documents/t/messages', {
          body: { text: 'wake up' },
          identity: 'peer',
        });
      })();

      const [res] = await Promise.all([waitPromise, sendPromise]);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      const data = (await res.json()) as { events: { kind: string }[]; cursor: number };
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events.some((e) => e.kind === 'message')).toBe(true);
      expect(elapsed).toBeLessThan(3000); // not the full 10s timeout
    });
  });

  describe('endpoint propose concurrency', () => {
    const opSpec = {
      summary: 'create',
      responses: { '200': { description: 'ok' } },
    };

    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 'c' } });
    });

    it('second propose without flags → 409 version_in_flight', async () => {
      const ok = await call('POST', '/documents/c/endpoints', {
        body: { method: 'post', path: '/users', spec: opSpec },
      });
      expect(ok.status).toBe(201);
      const blocked = await call('POST', '/documents/c/endpoints', {
        body: { method: 'post', path: '/users', spec: opSpec },
        identity: 'peer',
      });
      expect(blocked.status).toBe(409);
      const body = (await blocked.json()) as { code: string };
      expect(body.code).toBe('version_in_flight');
    });

    it('force=true overrides the in-flight block', async () => {
      await call('POST', '/documents/c/endpoints', {
        body: { method: 'post', path: '/users', spec: opSpec },
      });
      const forced = await call('POST', '/documents/c/endpoints?force=true', {
        body: { method: 'post', path: '/users', spec: opSpec },
        identity: 'peer',
      });
      expect(forced.status).toBe(201);
    });

    it('expected_version=new on a fresh artifact → 201; on an existing one → 409 version_mismatch', async () => {
      const fresh = await call('POST', '/documents/c/endpoints?expected_version=new', {
        body: { method: 'post', path: '/users', spec: opSpec },
      });
      expect(fresh.status).toBe(201);
      const conflict = await call('POST', '/documents/c/endpoints?expected_version=new', {
        body: { method: 'post', path: '/users', spec: opSpec },
        identity: 'peer',
      });
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { code: string };
      expect(body.code).toBe('version_mismatch');
    });
  });

  describe('endpoint withdraw', () => {
    const opSpec = {
      summary: 'create',
      responses: { '200': { description: 'ok' } },
    };

    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 'wd' } });
    });

    it('proposer can withdraw — 200', async () => {
      await call('POST', '/documents/wd/endpoints', {
        body: { method: 'post', path: '/users', spec: opSpec },
        identity: 'host',
      });
      const res = await call('POST', '/documents/wd/endpoints/POST%20%2Fusers/withdraw', {
        identity: 'host',
      });
      expect(res.status).toBe(200);
    });

    it('non-proposer gets 403 cannot_withdraw_others', async () => {
      await call('POST', '/documents/wd/endpoints', {
        body: { method: 'post', path: '/users', spec: opSpec },
        identity: 'host',
      });
      const res = await call('POST', '/documents/wd/endpoints/POST%20%2Fusers/withdraw', {
        identity: 'peer',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('cannot_withdraw_others');
    });

    it('withdraw of an already-accepted version (explicit ?version=N) → 409 artifact_not_pending', async () => {
      await call('POST', '/documents/wd/endpoints', {
        body: { method: 'post', path: '/users', spec: opSpec },
        identity: 'host',
      });
      await call('POST', '/documents/wd/endpoints/POST%20%2Fusers/accept', { identity: 'peer' });
      // Explicit version=1 because there's no proposed version to default to.
      const res = await call('POST', '/documents/wd/endpoints/POST%20%2Fusers/withdraw?version=1', {
        identity: 'host',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('artifact_not_pending');
    });
  });

  describe('spec validation on propose', () => {
    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 'v' } });
    });

    it('rejects a convention with an http-typed securityScheme missing `scheme` (the bearer-no-scheme case)', async () => {
      const res = await call('POST', '/documents/v/convention', {
        body: {
          spec: {
            info: { title: 'X', version: '1.0.0' },
            securitySchemes: { bearerAuth: { type: 'http' } },
          },
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code: string;
        issues?: { field: string; message: string }[];
      };
      expect(body.code).toBe('spec_invalid');
      expect(body.issues?.length ?? 0).toBeGreaterThan(0);
      // Field paths are assembled-doc-relative (the validator runs on the projected doc):
      // securitySchemes land under `components.securitySchemes.X` in OpenAPI.
      expect(
        body.issues?.some(
          (i) =>
            i.field.startsWith('components.securitySchemes.bearerAuth') &&
            /scheme/i.test(i.message),
        ),
      ).toBe(true);
    });

    it('rejects an endpoint propose with a non-Header-object response header', async () => {
      // `headers` is passthrough at the zod layer (record<string,unknown>); the meta-schema
      // requires each header value to be a Header Object, not a string. This is squarely the
      // validator's territory.
      const res = await call('POST', '/documents/v/endpoints', {
        body: {
          method: 'post',
          path: '/users',
          spec: {
            responses: {
              '200': { description: 'ok', headers: { 'X-Foo': 'just a string' } },
            },
          },
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; issues?: unknown[] };
      expect(body.code).toBe('spec_invalid');
      expect(body.issues?.length ?? 0).toBeGreaterThan(0);
    });

    it('accepts a propose with a valid spec (sanity)', async () => {
      const res = await call('POST', '/documents/v/convention', {
        body: {
          spec: {
            info: { title: 'X', version: '1.0.0' },
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
          },
        },
      });
      expect(res.status).toBe(201);
    });

    it('rejects a schema propose referencing a schema that is not yet in the doc (dangling ref)', async () => {
      // Missing-ref case: MessageList references Message before Message is in the doc.
      const res = await call('POST', '/documents/v/schemas', {
        body: {
          name: 'MessageList',
          spec: {
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: { $ref: '#/components/schemas/Message' },
              },
            },
          },
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; issues?: { message: string }[] };
      expect(body.code).toBe('spec_invalid');
      expect(body.issues?.some((i) => i.message.includes('Message'))).toBe(true);
    });

    it('accepts a schema propose whose ref target was proposed first', async () => {
      // Propose the dependency first
      const dep = await call('POST', '/documents/v/schemas', {
        body: { name: 'Message', spec: { type: 'object' } },
      });
      expect(dep.status).toBe(201);
      // Now the dependent ref resolves
      const res = await call('POST', '/documents/v/schemas', {
        body: {
          name: 'MessageList',
          spec: {
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: { $ref: '#/components/schemas/Message' },
              },
            },
          },
        },
      });
      expect(res.status).toBe(201);
    });

    it('rejects an accept that would leave the assembled-accepted doc with a dangling ref', async () => {
      // Propose Message + MessageList; reject Message; try to accept MessageList.
      await call('POST', '/documents/v/schemas', {
        body: { name: 'Message', spec: { type: 'object' } },
        identity: 'host',
      });
      await call('POST', '/documents/v/schemas', {
        body: {
          name: 'MessageList',
          spec: {
            type: 'object',
            properties: {
              messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
            },
          },
        },
        identity: 'host',
      });
      // Peer rejects Message
      const rej = await call('POST', '/documents/v/schemas/Message/reject', {
        body: { reason: 'wrong shape' },
        identity: 'peer',
      });
      expect(rej.status).toBe(200);
      // Peer tries to accept MessageList — should fail because Message isn't accepted
      const acc = await call('POST', '/documents/v/schemas/MessageList/accept', {
        identity: 'peer',
      });
      expect(acc.status).toBe(400);
      const body = (await acc.json()) as { code: string };
      expect(body.code).toBe('spec_invalid');
    });
  });

  describe('atomic propose-batch', () => {
    beforeEach(async () => {
      await call('POST', '/documents', { body: { name: 'b' } });
    });

    it('accepts mutually-referencing schemas in a single batch', async () => {
      // Person refs Address, Address refs Person — neither could be proposed first via
      // the per-propose endpoint. The atomic batch assembles both into the wide doc and
      // validates once, so mutual refs resolve.
      const res = await call('POST', '/documents/b/propose-batch', {
        body: {
          schemas: [
            {
              name: 'Person',
              spec: {
                type: 'object',
                properties: { address: { $ref: '#/components/schemas/Address' } },
              },
            },
            {
              name: 'Address',
              spec: {
                type: 'object',
                properties: { resident: { $ref: '#/components/schemas/Person' } },
              },
            },
          ],
        },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        succeeded: Array<{ kind: string; name?: string }>;
      };
      const names = body.succeeded.filter((s) => s.kind === 'schema').map((s) => s.name);
      expect(names).toEqual(['Person', 'Address']);
    });

    it('rejects the whole batch on a meta-schema failure, with no writes', async () => {
      const res = await call('POST', '/documents/b/propose-batch', {
        body: {
          convention: {
            spec: {
              info: { title: 'X', version: '1.0.0' },
              // bearer with no scheme — meta-schema failure
              securitySchemes: { bearerAuth: { type: 'http' } },
            },
          },
          schemas: [{ name: 'User', spec: { type: 'object' } }],
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('spec_invalid');
      // Confirm User wasn't written: GET it as proposed returns 404
      const userCheck = await call('GET', '/documents/b/schemas/User?proposed=true', {});
      expect(userCheck.status).toBe(404);
    });

    it('order within a batch does not matter for forward refs', async () => {
      // Reply listed before Message in the batch; should still validate atomically.
      const res = await call('POST', '/documents/b/propose-batch', {
        body: {
          schemas: [
            {
              name: 'Reply',
              spec: {
                type: 'object',
                properties: { parent: { $ref: '#/components/schemas/Message' } },
              },
            },
            { name: 'Message', spec: { type: 'object' } },
          ],
        },
      });
      expect(res.status).toBe(201);
    });
  });

  describe('inbox', () => {
    it('lists documents with new events for the caller', async () => {
      await call('POST', '/documents', { body: { name: 'a' }, identity: 'host' });
      await call('POST', '/documents', { body: { name: 'b' }, identity: 'host' });
      await call('POST', '/documents/a/messages', { body: { text: 'hi' }, identity: 'host' });

      const res = await call('GET', '/inbox', { identity: 'peer' });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        identity: string;
        documents: { documentName: string }[];
      };
      const names = data.documents.map((t) => t.documentName);
      expect(names).toContain('a');
      expect(names).toContain('b');
    });
  });

  describe('accept --rationale', () => {
    it('attaches the rationale to the artifact_accepted event', async () => {
      await call('POST', '/documents', { body: { name: 'r' } });
      // host proposes a minimal schema
      const prop = await call('POST', '/documents/r/schemas', {
        body: { name: 'Foo', spec: { type: 'object' } },
      });
      expect(prop.status).toBe(201);
      // peer accepts with rationale
      const acc = await call('POST', '/documents/r/schemas/Foo/accept', {
        identity: 'peer',
        body: { reason: 'matches the API.md shape' },
      });
      expect(acc.status).toBe(200);
      // The reason should show up on the artifact_accepted event in the stream
      const events = (await (await call('GET', '/documents/r/events?since=0')).json()) as {
        events: { kind: string; reason?: string }[];
      };
      const acceptEv = events.events.find((e) => e.kind === 'artifact_accepted');
      expect(acceptEv).toBeDefined();
      expect(acceptEv?.reason).toBe('matches the API.md shape');
    });

    it('accept with no body still works (back-compat)', async () => {
      await call('POST', '/documents', { body: { name: 'r2' } });
      await call('POST', '/documents/r2/schemas', {
        body: { name: 'Bar', spec: { type: 'object' } },
      });
      const acc = await call('POST', '/documents/r2/schemas/Bar/accept', { identity: 'peer' });
      expect(acc.status).toBe(200);
      const events = (await (await call('GET', '/documents/r2/events?since=0')).json()) as {
        events: { kind: string; reason?: string }[];
      };
      const acceptEv = events.events.find((e) => e.kind === 'artifact_accepted');
      expect(acceptEv).toBeDefined();
      expect(acceptEv?.reason).toBeUndefined();
    });
  });
});

describe('server (TCP transport + invite/connect)', () => {
  let tmp: string;
  let server: RunningServer;
  let tcpUrl: string;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-srv-tcp-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
        bind: '127.0.0.1:0', // auto-port
      },
    });
    if (!server.tcpAddress) throw new Error('expected tcp bind');
    tcpUrl = `http://127.0.0.1:${server.tcpAddress.port}`;
  });

  afterEach(async () => {
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('TCP requires bearer auth (401 without it)', async () => {
    const res = await fetch(`${tcpUrl}/whoami`);
    expect(res.status).toBe(401);
  });

  it('invite + connect issues a token that authenticates subsequent TCP calls', async () => {
    // Use the socket transport to create the invite (admin-style).
    const sockAgent = new Agent({ connect: { socketPath: server.socketPath } });
    try {
      const inv = await undiciFetch(`http://localhost/invites`, {
        method: 'POST',
        headers: {
          'X-Brackish-Identity': 'admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ identity: 'peer', ttlSeconds: 60 }),
        dispatcher: sockAgent,
      });
      expect(inv.status).toBe(200);
      const invData = (await inv.json()) as { inviteToken: string };

      // Now redeem via TCP /connect (no bearer needed for connect).
      const con = await fetch(`${tcpUrl}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: invData.inviteToken }),
      });
      expect(con.status).toBe(200);
      const conData = (await con.json()) as { identity: string; token: string };
      expect(conData.identity).toBe('peer');

      // Use the persistent token to authenticate /whoami on TCP.
      const me = await fetch(`${tcpUrl}/whoami`, {
        headers: { Authorization: `Bearer ${conData.token}` },
      });
      expect(me.status).toBe(200);
      const meData = (await me.json()) as { identity: string };
      expect(meData.identity).toBe('peer');
    } finally {
      await sockAgent.close();
    }
  });

  it('TCP rejects an invalid bearer token', async () => {
    const res = await fetch(`${tcpUrl}/whoami`, {
      headers: { Authorization: 'Bearer not-a-real-token-just-padding-to-pass-len' },
    });
    expect(res.status).toBe(401);
  });
});

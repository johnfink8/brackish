import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Response as UndiciResponse, fetch as undiciFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/server.js';

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

  describe('threads', () => {
    it('create + list + get', async () => {
      const cr = await call('POST', '/threads', { body: { name: 'contracts' } });
      expect(cr.status).toBe(201);

      const list = await call('GET', '/threads');
      const data = (await list.json()) as { threads: { name: string }[] };
      expect(data.threads.map((t) => t.name)).toContain('contracts');

      const get = await call('GET', '/threads/contracts');
      expect(get.status).toBe(200);
    });

    it('duplicate create returns 409', async () => {
      await call('POST', '/threads', { body: { name: 'dup' } });
      const res = await call('POST', '/threads', { body: { name: 'dup' } });
      expect(res.status).toBe(409);
    });

    it('get unknown thread returns 404', async () => {
      const res = await call('GET', '/threads/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('messages, events, cursor', () => {
    beforeEach(async () => {
      await call('POST', '/threads', { body: { name: 't' } });
    });

    it('send + list events from cursor 0', async () => {
      await call('POST', '/threads/t/messages', { body: { text: 'hello' } });
      const res = await call('GET', '/threads/t/events?since=0');
      expect(res.status).toBe(200);
      const data = (await res.json()) as { events: { kind: string }[]; cursor: number };
      expect(data.events.length).toBeGreaterThanOrEqual(2); // thread_created + message
      expect(data.cursor).toBeGreaterThan(0);
    });

    it('list events advances server-tracked cursor', async () => {
      await call('POST', '/threads/t/messages', { body: { text: 'one' } });
      const r1 = (await (await call('GET', '/threads/t/events?since=0')).json()) as {
        cursor: number;
      };
      // A subsequent wait with no since uses last-seen cursor; should not return the
      // already-read events as fresh.
      const r2 = (await (await call('GET', '/threads/t/wait?timeout=1')).json()) as {
        events: unknown[];
        cursor: number;
      };
      expect(r2.events).toEqual([]);
      expect(r2.cursor).toBe(r1.cursor);
    });

    it('explicit since=N overrides server-tracked cursor', async () => {
      await call('POST', '/threads/t/messages', { body: { text: 'one' } });
      const r = (await (await call('GET', '/threads/t/events?since=0')).json()) as {
        events: unknown[];
        cursor: number;
      };
      // re-read from 0 — should see them again
      const reread = (await (await call('GET', '/threads/t/events?since=0')).json()) as {
        events: unknown[];
      };
      expect(reread.events.length).toBe(r.events.length);
    });
  });

  describe('long-poll wait', () => {
    beforeEach(async () => {
      await call('POST', '/threads', { body: { name: 't' } });
      // drain initial thread_created event for "host" identity by reading once
      await call('GET', '/threads/t/events');
    });

    it('times out cleanly when nothing arrives', async () => {
      const t0 = Date.now();
      const res = await call('GET', '/threads/t/wait?timeout=1');
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      const data = (await res.json()) as { events: unknown[]; cursor: number };
      expect(data.events).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2500);
    });

    it('wakes the moment a new message arrives from another identity', async () => {
      const t0 = Date.now();
      const waitPromise = call('GET', '/threads/t/wait?timeout=10');
      // Send a message ~150ms later as a different identity.
      const sendPromise = (async () => {
        await new Promise((r) => setTimeout(r, 150));
        await call('POST', '/threads/t/messages', {
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

  describe('inbox', () => {
    it('lists threads with new events for the caller', async () => {
      await call('POST', '/threads', { body: { name: 'a' }, identity: 'host' });
      await call('POST', '/threads', { body: { name: 'b' }, identity: 'host' });
      await call('POST', '/threads/a/messages', { body: { text: 'hi' }, identity: 'host' });

      const res = await call('GET', '/inbox', { identity: 'peer' });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        identity: string;
        threads: { threadName: string }[];
      };
      const names = data.threads.map((t) => t.threadName);
      expect(names).toContain('a');
      expect(names).toContain('b');
    });
  });

  describe('artifact lifecycle', () => {
    beforeEach(async () => {
      await call('POST', '/threads', { body: { name: 't' } });
    });

    it('propose + accept + get current', async () => {
      const propose = await call('POST', '/threads/t/artifacts', {
        body: { name: 'users', kind: 'openapi', content: 'openapi: 3.0' },
      });
      expect(propose.status).toBe(201);
      const v = (await propose.json()) as { version: number; status: string };
      expect(v.version).toBe(1);
      expect(v.status).toBe('proposed');

      // The proposer cannot accept their own version.
      const ownAccept = await call('POST', '/threads/t/artifacts/users/accept');
      expect(ownAccept.status).toBe(403);

      // Acceptance by a different identity succeeds.
      const accept = await call('POST', '/threads/t/artifacts/users/accept', {
        identity: 'peer',
      });
      expect(accept.status).toBe(200);

      // Current accepted version is now retrievable.
      const cur = await call('GET', '/threads/t/artifacts/users');
      expect(cur.status).toBe(200);
      const curData = (await cur.json()) as { status: string; content: string };
      expect(curData.status).toBe('accepted');
      expect(curData.content).toBe('openapi: 3.0');
    });

    it('reject by peer with reason', async () => {
      await call('POST', '/threads/t/artifacts', {
        body: { name: 'users', kind: 'openapi', content: 'spec' },
      });
      const reject = await call('POST', '/threads/t/artifacts/users/reject', {
        identity: 'peer',
        body: { reason: 'needs auth section' },
      });
      expect(reject.status).toBe(200);
      const data = (await reject.json()) as { status: string; rejectionReason: string };
      expect(data.status).toBe('rejected');
      expect(data.rejectionReason).toBe('needs auth section');
    });

    it('artifact list summarizes current + latestProposed per name', async () => {
      await call('POST', '/threads/t/artifacts', {
        body: { name: 'users', kind: 'openapi', content: 'v1' },
      });
      await call('POST', '/threads/t/artifacts/users/accept', { identity: 'peer' });
      await call('POST', '/threads/t/artifacts', {
        body: { name: 'users', kind: 'openapi', content: 'v2' },
      });
      const res = await call('GET', '/threads/t/artifacts');
      const data = (await res.json()) as {
        artifacts: {
          name: string;
          currentVersion: number | null;
          latestProposedVersion: number | null;
        }[];
      };
      const users = data.artifacts.find((a) => a.name === 'users');
      expect(users?.currentVersion).toBe(1);
      expect(users?.latestProposedVersion).toBe(2);
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

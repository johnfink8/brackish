import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrackishClient, ClientError, redeemInvite } from '../src/client.js';
import { type RunningServer, startServer } from '../src/server.js';

describe('BrackishClient (socket mode)', () => {
  let tmp: string;
  let server: RunningServer;
  let host: BrackishClient;
  let peer: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-cli-test-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    host = new BrackishClient({ socketPath: server.socketPath, identity: 'host' });
    peer = new BrackishClient({ socketPath: server.socketPath, identity: 'peer' });
  });

  afterEach(async () => {
    await host.close();
    await peer.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('whoami returns the configured identity', async () => {
    const me = await host.whoami();
    expect(me.identity).toBe('host');
  });

  it('thread + message round-trip', async () => {
    const t = await host.createThread('contracts');
    expect(t.name).toBe('contracts');
    const msg = await host.sendMessage('contracts', 'hello');
    expect(msg.kind).toBe('message');
    if (msg.kind === 'message') {
      expect(msg.text).toBe('hello');
      expect(msg.from).toBe('host');
    }
  });

  it('listEvents + wait + cursor semantics', async () => {
    await host.createThread('t');
    await host.sendMessage('t', 'first');

    // wait with timeout should return immediately with at least one event
    const first = await host.wait('t', { timeoutSeconds: 5 });
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.cursor).toBeGreaterThan(0);

    // subsequent wait should be empty (cursor advanced)
    const empty = await host.wait('t', { timeoutSeconds: 1 });
    expect(empty.events).toEqual([]);
    expect(empty.cursor).toBe(first.cursor);
  });

  it('artifact propose/accept lifecycle, get current', async () => {
    await host.createThread('t');
    const proposed = await host.proposeArtifact('t', 'users', 'openapi', 'spec-v1');
    expect(proposed.status).toBe('proposed');
    expect(proposed.version).toBe(1);

    const accepted = await peer.acceptArtifact('t', 'users');
    expect(accepted.status).toBe('accepted');

    const cur = await peer.getArtifact('t', 'users');
    expect(cur.status).toBe('accepted');
    expect(cur.content).toBe('spec-v1');
  });

  it('artifact reject preserves reason', async () => {
    await host.createThread('t');
    await host.proposeArtifact('t', 'users', 'openapi', 'spec');
    const rejected = await peer.rejectArtifact('t', 'users', 'needs auth section');
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') {
      expect(rejected.rejectionReason).toBe('needs auth section');
    }
  });

  it('inbox surfaces threads with new events for the caller identity', async () => {
    await host.createThread('a');
    await host.sendMessage('a', 'hi from host');
    const peerInbox = await peer.inbox();
    expect(peerInbox.threads.some((t) => t.threadName === 'a')).toBe(true);
  });

  it('ClientError carries HTTP status + code on 4xx', async () => {
    await expect(host.getThread('nonexistent')).rejects.toBeInstanceOf(ClientError);
    try {
      await host.getThread('nonexistent');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      if (err instanceof ClientError) {
        expect(err.status).toBe(404);
        expect(err.code).toBe('thread_not_found');
      }
    }
  });

  it('cannot_accept_own surfaces as ClientError with status 403', async () => {
    await host.createThread('t');
    await host.proposeArtifact('t', 'x', 'openapi', 'spec');
    await expect(host.acceptArtifact('t', 'x')).rejects.toMatchObject({
      status: 403,
      code: 'cannot_accept_own',
    });
  });
});

describe('BrackishClient (TCP mode via invite/connect)', () => {
  let tmp: string;
  let server: RunningServer;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-cli-tcp-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
        bind: '127.0.0.1:0',
      },
    });
    if (!server.tcpAddress) throw new Error('expected TCP bind');
  });

  afterEach(async () => {
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('full bootstrap: admin (socket) issues invite → peer redeems over TCP → peer uses persistent token', async () => {
    const admin = new BrackishClient({
      socketPath: server.socketPath,
      identity: 'admin',
    });
    try {
      const inv = await admin.createInvite('peer', 300);
      if (!server.tcpAddress) throw new Error('no tcp address');
      const url = `http://127.0.0.1:${server.tcpAddress.port}`;
      // redeemInvite is a standalone (no auth needed) bootstrap helper.
      const persistent = await redeemInvite(url, inv.inviteToken);
      expect(persistent.identity).toBe('peer');
      expect(persistent.token.length).toBeGreaterThan(20);

      const peer = new BrackishClient({ server: url, token: persistent.token });
      const me = await peer.whoami();
      expect(me.identity).toBe('peer');
    } finally {
      await admin.close();
    }
  });
});

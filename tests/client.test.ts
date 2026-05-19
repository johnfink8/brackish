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

  it('document + message round-trip', async () => {
    const t = await host.createDocument('contracts');
    expect(t.name).toBe('contracts');
    const msg = await host.sendMessage('contracts', 'hello');
    expect(msg.kind).toBe('message');
    if (msg.kind === 'message') {
      expect(msg.text).toBe('hello');
      expect(msg.from).toBe('host');
    }
  });

  it('listEvents + wait + cursor semantics', async () => {
    await host.createDocument('t');
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

  it('inbox surfaces documents with new events for the caller identity', async () => {
    await host.createDocument('a');
    await host.sendMessage('a', 'hi from host');
    const peerInbox = await peer.inbox();
    expect(peerInbox.documents.some((t) => t.documentName === 'a')).toBe(true);
  });

  it('ClientError carries HTTP status + code on 4xx', async () => {
    await expect(host.getDocument('nonexistent')).rejects.toBeInstanceOf(ClientError);
    try {
      await host.getDocument('nonexistent');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientError);
      if (err instanceof ClientError) {
        expect(err.status).toBe(404);
        expect(err.code).toBe('document_not_found');
      }
    }
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

describe('OpenAPI artifact lifecycle via client (socket mode)', () => {
  let tmp: string;
  let server: RunningServer;
  let host: BrackishClient;
  let peer: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-openapi-cli-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    host = new BrackishClient({ socketPath: server.socketPath, identity: 'host' });
    peer = new BrackishClient({ socketPath: server.socketPath, identity: 'peer' });
    await host.createDocument('orders');
  });

  afterEach(async () => {
    await host.close();
    await peer.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  const minOp = (summary: string) => ({ summary, responses: { '200': { description: 'ok' } } });

  it('endpoint propose + accept + getEndpoint', async () => {
    const proposed = await host.proposeEndpoint('orders', 'post', '/users', minOp('create'));
    expect(proposed.method).toBe('post');
    expect(proposed.path).toBe('/users');
    expect(proposed.version).toBe(1);
    expect(proposed.status).toBe('proposed');
    const accepted = await peer.acceptEndpoint('orders', 'post', '/users');
    expect(accepted.status).toBe('accepted');
    const cur = await peer.getEndpoint('orders', 'post', '/users');
    expect(cur.version).toBe(1);
    expect(cur.status).toBe('accepted');
  });

  it('endpoint diff returns RFC 6902 patch between versions', async () => {
    await host.proposeEndpoint('orders', 'post', '/users', minOp('v1'));
    await peer.acceptEndpoint('orders', 'post', '/users');
    await host.proposeEndpoint('orders', 'post', '/users', {
      ...minOp('v1'),
      responses: { '200': { description: 'ok' }, '409': { description: 'taken' } },
    });
    const diff = await host.diffEndpoint('orders', 'post', '/users', { from: 1, to: 2 });
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.patch.some((op) => op.op === 'add' && op.path.includes('/409'))).toBe(true);
  });

  it('schema propose + accept + list', async () => {
    await host.proposeSchema('orders', 'User', {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    await peer.acceptSchema('orders', 'User');
    const list = await host.listSchemas('orders');
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('User');
    expect(list[0]?.currentVersion).toBe(1);
  });

  it('convention propose + accept', async () => {
    await host.proposeConvention('orders', {
      info: { title: 'Orders API', version: '1.0.0' },
    });
    await peer.acceptConvention('orders');
    const cur = await host.getConventionCurrent('orders');
    expect(cur.version).toBe(1);
  });

  it('cannot_accept_own surfaces as 403 ClientError', async () => {
    await host.proposeEndpoint('orders', 'post', '/users', minOp('mine'));
    await expect(host.acceptEndpoint('orders', 'post', '/users')).rejects.toMatchObject({
      status: 403,
      code: 'cannot_accept_own',
    });
  });

  it('getOpenApiYaml renders accepted artifacts only', async () => {
    await host.proposeConvention('orders', { info: { title: 'Orders API', version: '1.0.0' } });
    await peer.acceptConvention('orders');
    await host.proposeEndpoint('orders', 'post', '/users', minOp('create'));
    await peer.acceptEndpoint('orders', 'post', '/users');
    const yaml = await host.getOpenApiYaml('orders');
    expect(yaml).toContain('openapi: 3.1.0');
    expect(yaml).toContain('title: Orders API');
    expect(yaml).toContain('/users');
  });

  it('getRationaleJson returns version chains keyed by identity', async () => {
    await host.proposeEndpoint('orders', 'post', '/users', minOp('v1'));
    await peer.rejectEndpoint('orders', 'post', '/users', 'needs more thought');
    await host.proposeEndpoint('orders', 'post', '/users', minOp('v2'));
    await peer.acceptEndpoint('orders', 'post', '/users');
    const rationale = (await host.getRationaleJson('orders')) as {
      endpoints: Record<string, { status: string }[]>;
    };
    const chain = rationale.endpoints['POST /users'];
    expect(chain).toBeDefined();
    expect(chain).toHaveLength(2);
    expect(chain?.[0]?.status).toBe('rejected');
    expect(chain?.[1]?.status).toBe('accepted');
  });

  it('TOKEN-EFFICIENCY: a reject-iterate-accept cycle uses the diff path; budget held', async () => {
    let bytes = 0;
    const v1 = await host.proposeSchema('orders', 'User', {
      type: 'object',
      properties: { id: { type: 'string' }, createdAt: { type: 'integer' } },
      required: ['id'],
    });
    bytes += JSON.stringify(v1).length;
    await peer.rejectSchema('orders', 'User', 'createdAt should be ISO 8601 string');
    const ev = await peer.listEvents('orders');
    bytes += JSON.stringify(
      ev.events.filter((e) => e.kind === 'artifact_rejected').slice(-1),
    ).length;
    const v2 = await host.proposeSchema('orders', 'User', {
      type: 'object',
      properties: { id: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } },
      required: ['id'],
    });
    bytes += JSON.stringify(v2).length;
    const diff = await host.diffSchema('orders', 'User', { from: 1, to: 2 });
    bytes += JSON.stringify(diff).length;
    await peer.acceptSchema('orders', 'User');
    expect(bytes).toBeLessThan(2500);
  });
});

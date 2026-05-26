import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrackishClient } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';

// Batch accept is ATOMIC: BrackishClient.batchAcceptSchemas/Endpoints submit the whole set to one
// server transaction. It either returns every accepted version or rejects with NOTHING accepted —
// there is no partial-success / `remaining` shape. The "accepts nothing on failure" assertions
// prove the rollback: the still-valid items remain `proposed` (a follow-up single accept succeeds).

describe('batchAcceptSchemas (atomic)', () => {
  let tmp: string;
  let server: RunningServer;
  let host: BrackishClient;
  let peer: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-batch-test-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: { socketPath: join(tmp, 'brackish.sock'), dataPath: join(tmp, 'brackish.db') },
    });
    host = new BrackishClient({ socketPath: server.socketPath, identity: 'host' });
    peer = new BrackishClient({ socketPath: server.socketPath, identity: 'peer' });
    await host.createDocument('d');
  });

  afterEach(async () => {
    await host.close();
    await peer.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts the whole set when all succeed', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    await peer.proposeSchema('d', 'Order', { type: 'object' });
    await peer.proposeSchema('d', 'OrderItem', { type: 'object' });
    const { accepted } = await host.batchAcceptSchemas('d', ['User', 'Order', 'OrderItem']);
    expect(accepted.map((a) => a.name)).toEqual(['User', 'Order', 'OrderItem']);
  });

  it('rejects the whole batch and accepts nothing when one item fails (cannot_accept_own)', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    await peer.proposeSchema('d', 'Order', { type: 'object' });
    await host.proposeSchema('d', 'Customer', { type: 'object' }); // host can't accept its own

    await expect(host.batchAcceptSchemas('d', ['User', 'Order', 'Customer'])).rejects.toMatchObject(
      { code: 'cannot_accept_own' },
    );

    // Nothing committed — checked directly: User + Order have no accepted version (currentVersion
    // null) and are still proposed. A non-atomic loop would have accepted both before Customer failed.
    const summaries = await host.listSchemas('d');
    for (const name of ['User', 'Order']) {
      const s = summaries.find((x) => x.name === name);
      expect(s?.currentVersion).toBeNull();
      expect(s?.latestProposedVersion).toBe(1);
    }
    // And they remain in flight: accepting them now succeeds (confirms the rollback, not a tombstone).
    const { accepted: recovered } = await host.batchAcceptSchemas('d', ['User', 'Order']);
    expect(recovered.map((a) => a.name)).toEqual(['User', 'Order']);
  });

  it('rejects the whole batch when an item is not found', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    await expect(host.batchAcceptSchemas('d', ['User', 'Missing'])).rejects.toMatchObject({
      code: 'artifact_not_found',
    });
    const { accepted: recovered } = await host.batchAcceptSchemas('d', ['User']);
    expect(recovered.map((a) => a.name)).toEqual(['User']);
  });

  it('accepts a mutually-referencing set together that a single accept would reject', async () => {
    await peer.proposeSchema('d', 'OrderItem', { type: 'object' });
    await peer.proposeSchema('d', 'Order', {
      type: 'object',
      properties: { item: { $ref: '#/components/schemas/OrderItem' } },
    });
    // Accepting Order alone would orphan its $ref to the still-proposed OrderItem. The error names
    // the missing ref and points at accepting it too — not the generic "doc is wedged" message.
    await expect(host.batchAcceptSchemas('d', ['Order'])).rejects.toMatchObject({
      code: 'accept_orphans_ref',
      message: expect.stringContaining('OrderItem'),
    });
    // Accepting both together validates as one assembled doc and commits atomically.
    const { accepted } = await host.batchAcceptSchemas('d', ['Order', 'OrderItem']);
    expect(accepted.map((a) => a.name)).toEqual(['Order', 'OrderItem']);
  });

  it('--include-dependencies pulls in the proposed $ref-closure, accepting it atomically', async () => {
    await peer.proposeSchema('d', 'OrderItem', { type: 'object' });
    await peer.proposeSchema('d', 'Order', {
      type: 'object',
      properties: { item: { $ref: '#/components/schemas/OrderItem' } },
    });
    // Accept Order alone, but opt into dependencies → OrderItem comes along in the same batch.
    const res = await host.batchAcceptSchemas('d', ['Order'], undefined, true);
    expect(res.accepted.map((a) => a.name)).toEqual(['Order']);
    expect(res.dependencies).toEqual(['schema OrderItem']);
    // Both are now accepted.
    const summaries = await host.listSchemas('d');
    for (const name of ['Order', 'OrderItem']) {
      expect(summaries.find((s) => s.name === name)?.currentVersion).toBe(1);
    }
  });
});

describe('batchAcceptEndpoints (atomic)', () => {
  let tmp: string;
  let server: RunningServer;
  let host: BrackishClient;
  let peer: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;
  const minOp = { responses: { '200': { description: 'OK' } } };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-batch-test-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: { socketPath: join(tmp, 'brackish.sock'), dataPath: join(tmp, 'brackish.db') },
    });
    host = new BrackishClient({ socketPath: server.socketPath, identity: 'host' });
    peer = new BrackishClient({ socketPath: server.socketPath, identity: 'peer' });
    await host.createDocument('d');
  });

  afterEach(async () => {
    await host.close();
    await peer.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts the whole set when all succeed', async () => {
    await peer.proposeEndpoint('d', 'get', '/users', minOp);
    await peer.proposeEndpoint('d', 'post', '/users', minOp);
    await peer.proposeEndpoint('d', 'get', '/users/{id}', minOp);
    const { accepted } = await host.batchAcceptEndpoints('d', [
      { method: 'get', path: '/users' },
      { method: 'post', path: '/users' },
      { method: 'get', path: '/users/{id}' },
    ]);
    expect(accepted.map((a) => `${a.method} ${a.path}`)).toEqual([
      'get /users',
      'post /users',
      'get /users/{id}',
    ]);
  });

  it('rejects the whole batch and accepts nothing when one target fails', async () => {
    await peer.proposeEndpoint('d', 'get', '/users', minOp);
    await peer.proposeEndpoint('d', 'post', '/users', minOp);
    await host.proposeEndpoint('d', 'delete', '/admin', minOp); // host can't accept its own

    await expect(
      host.batchAcceptEndpoints('d', [
        { method: 'get', path: '/users' },
        { method: 'post', path: '/users' },
        { method: 'delete', path: '/admin' },
      ]),
    ).rejects.toMatchObject({ code: 'cannot_accept_own' });

    // Nothing committed — checked directly: neither /users endpoint has an accepted version.
    const summaries = await host.listEndpoints('d');
    const getUsers = summaries.find((e) => e.method === 'get' && e.path === '/users');
    const postUsers = summaries.find((e) => e.method === 'post' && e.path === '/users');
    expect(getUsers?.currentVersion).toBeNull();
    expect(postUsers?.currentVersion).toBeNull();

    const { accepted: recovered } = await host.batchAcceptEndpoints('d', [
      { method: 'get', path: '/users' },
      { method: 'post', path: '/users' },
    ]);
    expect(recovered.map((a) => `${a.method} ${a.path}`)).toEqual(['get /users', 'post /users']);
  });
});

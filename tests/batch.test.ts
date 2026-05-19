import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptEndpoints, acceptSchemas } from '../src/client/batch.js';
import { BrackishClient } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';

describe('acceptSchemas', () => {
  let tmp: string;
  let server: RunningServer;
  let host: BrackishClient;
  let peer: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-batch-test-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
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

  it('accepts every schema in order when all succeed', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    await peer.proposeSchema('d', 'Order', { type: 'object' });
    await peer.proposeSchema('d', 'OrderItem', { type: 'object' });
    const result = await acceptSchemas(host, 'd', ['User', 'Order', 'OrderItem']);
    expect(result.failed).toBeNull();
    expect(result.accepted.map((a) => a.name)).toEqual(['User', 'Order', 'OrderItem']);
    expect(result.remaining).toEqual([]);
  });

  it('stops on the first failure, leaving remaining items unaccepted', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    await peer.proposeSchema('d', 'Order', { type: 'object' });
    // host proposes Customer themselves — accepting their own should fail with cannot_accept_own
    await host.proposeSchema('d', 'Customer', { type: 'object' });
    await peer.proposeSchema('d', 'Address', { type: 'object' });

    const result = await acceptSchemas(host, 'd', ['User', 'Order', 'Customer', 'Address']);
    expect(result.accepted.map((a) => a.name)).toEqual(['User', 'Order']);
    expect(result.failed?.name).toBe('Customer');
    expect(result.failed?.code).toBe('cannot_accept_own');
    expect(result.remaining).toEqual(['Address']);
  });

  it('reports a not-found name without touching the rest', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    await peer.proposeSchema('d', 'Order', { type: 'object' });
    const result = await acceptSchemas(host, 'd', ['User', 'Missing', 'Order']);
    expect(result.accepted.map((a) => a.name)).toEqual(['User']);
    expect(result.failed?.name).toBe('Missing');
    expect(result.failed?.code).toBe('artifact_not_found');
    expect(result.remaining).toEqual(['Order']);
  });

  it('a duplicate name fails the second hit (no proposed version left to accept)', async () => {
    await peer.proposeSchema('d', 'User', { type: 'object' });
    const result = await acceptSchemas(host, 'd', ['User', 'User']);
    expect(result.accepted.map((a) => a.name)).toEqual(['User']);
    expect(result.failed?.name).toBe('User');
    // The server resolves "latest proposed" before accepting; once accepted, there's nothing in
    // flight, so the second hit is artifact_not_found, not artifact_not_pending.
    expect(result.failed?.code).toBe('artifact_not_found');
  });
});

describe('acceptEndpoints', () => {
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
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
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

  it('accepts every endpoint in order when all succeed', async () => {
    await peer.proposeEndpoint('d', 'get', '/users', minOp);
    await peer.proposeEndpoint('d', 'post', '/users', minOp);
    await peer.proposeEndpoint('d', 'get', '/users/{id}', minOp);
    const result = await acceptEndpoints(host, 'd', [
      { method: 'get', path: '/users' },
      { method: 'post', path: '/users' },
      { method: 'get', path: '/users/{id}' },
    ]);
    expect(result.failed).toBeNull();
    expect(result.accepted.map((a) => `${a.method} ${a.path}`)).toEqual([
      'get /users',
      'post /users',
      'get /users/{id}',
    ]);
    expect(result.remaining).toEqual([]);
  });

  it('stops on the first failure, leaving remaining targets unaccepted', async () => {
    await peer.proposeEndpoint('d', 'get', '/users', minOp);
    await peer.proposeEndpoint('d', 'post', '/users', minOp);
    // host proposes /admin themselves → accepting their own fails with cannot_accept_own.
    await host.proposeEndpoint('d', 'delete', '/admin', minOp);
    await peer.proposeEndpoint('d', 'get', '/health', minOp);

    const result = await acceptEndpoints(host, 'd', [
      { method: 'get', path: '/users' },
      { method: 'post', path: '/users' },
      { method: 'delete', path: '/admin' },
      { method: 'get', path: '/health' },
    ]);
    expect(result.accepted.map((a) => `${a.method} ${a.path}`)).toEqual([
      'get /users',
      'post /users',
    ]);
    expect(result.failed?.target).toEqual({ method: 'delete', path: '/admin' });
    expect(result.failed?.code).toBe('cannot_accept_own');
    expect(result.remaining).toEqual([{ method: 'get', path: '/health' }]);
  });

  it('reports a not-found target without touching the rest', async () => {
    await peer.proposeEndpoint('d', 'get', '/users', minOp);
    await peer.proposeEndpoint('d', 'post', '/orders', minOp);
    const result = await acceptEndpoints(host, 'd', [
      { method: 'get', path: '/users' },
      { method: 'get', path: '/missing' },
      { method: 'post', path: '/orders' },
    ]);
    expect(result.accepted.map((a) => `${a.method} ${a.path}`)).toEqual(['get /users']);
    expect(result.failed?.target).toEqual({ method: 'get', path: '/missing' });
    expect(result.failed?.code).toBe('artifact_not_found');
    expect(result.remaining).toEqual([{ method: 'post', path: '/orders' }]);
  });

  it('a duplicate target fails the second hit (no proposed version left to accept)', async () => {
    await peer.proposeEndpoint('d', 'get', '/users', minOp);
    const result = await acceptEndpoints(host, 'd', [
      { method: 'get', path: '/users' },
      { method: 'get', path: '/users' },
    ]);
    expect(result.accepted.map((a) => `${a.method} ${a.path}`)).toEqual(['get /users']);
    expect(result.failed?.target).toEqual({ method: 'get', path: '/users' });
    expect(result.failed?.code).toBe('artifact_not_found');
  });
});

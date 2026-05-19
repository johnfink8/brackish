import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptSchemas } from '../src/client/batch.js';
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

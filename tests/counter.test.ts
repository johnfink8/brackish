import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrackishClient } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';

// `counter` = reject the current proposed version + propose a replacement, in ONE transaction.
// Either both land or neither does — no rejected-with-no-counter partial state.

describe('counterSchema (atomic reject + propose)', () => {
  let tmp: string;
  let server: RunningServer;
  let backend: BrackishClient;
  let frontend: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-counter-test-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: { socketPath: join(tmp, 'brackish.sock'), dataPath: join(tmp, 'brackish.db') },
    });
    backend = new BrackishClient({ socketPath: server.socketPath, identity: 'backend' });
    frontend = new BrackishClient({ socketPath: server.socketPath, identity: 'frontend' });
    await backend.createDocument('d');
  });

  afterEach(async () => {
    await backend.close();
    await frontend.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects the current proposed version and proposes the replacement, as one move', async () => {
    await backend.proposeSchema('d', 'User', {
      type: 'object',
      properties: { id: { type: 'integer' } },
    });
    const v2 = await frontend.counterSchema(
      'd',
      'User',
      { type: 'object', properties: { id: { type: 'string' } } },
      'id should be a string, not integer',
    );
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('proposed');
    expect(v2.proposedBy).toBe('frontend');

    // v1 is now rejected (peer-only reject) with the rationale attached.
    const v1 = await backend.getSchema('d', 'User', { version: 1 });
    expect(v1.status).toBe('rejected');
  });

  it('refuses to counter your own proposal, leaving it untouched (cannot_reject_own)', async () => {
    await backend.proposeSchema('d', 'User', { type: 'object' });
    await expect(
      backend.counterSchema('d', 'User', { type: 'object', properties: { x: {} } }, 'tweak'),
    ).rejects.toMatchObject({ code: 'cannot_reject_own' });

    // Nothing changed: v1 is still the proposed version, no v2 was created.
    const v1 = await backend.getSchema('d', 'User', { version: 1 });
    expect(v1.status).toBe('proposed');
    await expect(backend.getSchema('d', 'User', { version: 2 })).rejects.toMatchObject({
      code: 'artifact_not_found',
    });
  });

  it('refuses when there is no proposed version to counter', async () => {
    await expect(
      frontend.counterSchema('d', 'Ghost', { type: 'object' }, 'x'),
    ).rejects.toMatchObject({ code: 'artifact_not_pending' });
  });
});

// Tests for the `show` CLI's "always tagged, both-if-both-exist" behavior. The
// CLI's getOrNull + parallel-fetch + render shape is what's exercised here via
// the BrackishClient + startServer, since the rendering is pure-function over
// the API responses.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOrNull } from '../src/cli/common.js';
import { BrackishClient } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';
import { renderTaggedShow } from '../src/render/output.js';

describe('show — tagged accepted/proposed', () => {
  let tmp: string;
  let server: RunningServer;
  let alice: BrackishClient;
  let bob: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-show-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    alice = new BrackishClient({ socketPath: server.socketPath, identity: 'alice' });
    bob = new BrackishClient({ socketPath: server.socketPath, identity: 'bob' });
    await alice.createDocument('contracts');
  });

  afterEach(async () => {
    await alice.close();
    await bob.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  // Helper: simulate the CLI show command's logic at the API layer.
  const collectShow = async (
    name: string,
  ): Promise<{
    accepted: Awaited<ReturnType<typeof alice.getSchema>> | null;
    proposed: Awaited<ReturnType<typeof alice.getSchema>> | null;
  }> => {
    const [accepted, proposed] = await Promise.all([
      getOrNull(() => alice.getSchema('contracts', name)),
      getOrNull(() => alice.getSchema('contracts', name, { proposed: true })),
    ]);
    return { accepted, proposed };
  };

  it('returns only the proposed when no accepted yet (was the misfire case)', async () => {
    await alice.proposeSchema(
      'contracts',
      'Message',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      { expectedVersion: 'new' },
    );

    const result = await collectShow('Message');
    expect(result.accepted).toBeNull();
    expect(result.proposed?.status).toBe('proposed');
    expect(result.proposed?.version).toBe(1);

    const rendered = renderTaggedShow({ label: 'schema Message', ...result });
    expect(rendered).toContain('proposed v1 by alice');
    expect(rendered).not.toContain('accepted');
  });

  it('returns only the accepted when no proposed', async () => {
    await alice.proposeSchema(
      'contracts',
      'User',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      { expectedVersion: 'new' },
    );
    await bob.acceptSchema('contracts', 'User');

    const result = await collectShow('User');
    expect(result.accepted?.status).toBe('accepted');
    expect(result.proposed).toBeNull();

    const rendered = renderTaggedShow({ label: 'schema User', ...result });
    expect(rendered).toContain('accepted v1 by bob');
    expect(rendered).not.toContain('proposed');
  });

  it('returns BOTH accepted v1 + proposed v2 when peer is revising', async () => {
    await alice.proposeSchema(
      'contracts',
      'Message',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      { expectedVersion: 'new' },
    );
    await bob.acceptSchema('contracts', 'Message');
    // Now propose v2 — accepted v1 stays live, proposed v2 is the revision.
    await alice.proposeSchema(
      'contracts',
      'Message',
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'created_at'],
      },
      { expectedVersion: 1 },
    );

    const result = await collectShow('Message');
    expect(result.accepted?.status).toBe('accepted');
    expect(result.accepted?.version).toBe(1);
    expect(result.proposed?.status).toBe('proposed');
    expect(result.proposed?.version).toBe(2);

    const rendered = renderTaggedShow({ label: 'schema Message', ...result });
    expect(rendered).toContain('accepted v1 by bob');
    expect(rendered).toContain('proposed v2 by alice');
    // The delta line is rendered by the CLI's caller; here we just confirm both
    // sections are present with their full bodies.
    expect(rendered).toContain('created_at');
  });

  it("getOrNull returns null on artifact_not_found (the no-fallback fetch the CLI's show relies on)", async () => {
    const result = await getOrNull(() => alice.getSchema('contracts', 'NeverExisted'));
    expect(result).toBeNull();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectBuckets } from '../src/cli/status.js';
import { BrackishClient } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';

describe('status collectBuckets — blocked-on detection', () => {
  let tmp: string;
  let server: RunningServer;
  let alice: BrackishClient;
  let bob: BrackishClient;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-status-test-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
      },
    });
    alice = new BrackishClient({ socketPath: server.socketPath, identity: 'alice' });
    bob = new BrackishClient({ socketPath: server.socketPath, identity: 'bob' });
  });

  afterEach(async () => {
    await alice.close();
    await bob.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('annotates proposals whose $refs point at not-yet-accepted schemas', async () => {
    // The scenario the chat-app trial surfaced: one side proposes Message + MessageList,
    // MessageList $refs Message. Accepting MessageList would 400 on validation because
    // Message isn't in the accepted pool yet. Status must surface this directly so neither
    // side has to fall back to a plain-text `brackish send` explanation.
    await alice.createDocument('contracts');
    await alice.proposeSchema(
      'contracts',
      'Message',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      { expectedVersion: 'new' },
    );
    await alice.proposeSchema(
      'contracts',
      'MessageList',
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/Message' },
          },
        },
        required: ['items'],
      },
      { expectedVersion: 'new' },
    );

    const buckets = await collectBuckets(alice, 'contracts', 'alice');

    const messageList = buckets.awaitingPeer.find((r) => r.label === 'MessageList');
    expect(messageList).toBeDefined();
    expect(messageList?.blockedOn).toEqual(['Message']);

    // Message itself $refs nothing, so it's not blocked on anything.
    const message = buckets.awaitingPeer.find((r) => r.label === 'Message');
    expect(message?.blockedOn).toEqual([]);
  });

  it('clears the block annotation once the dependency is accepted', async () => {
    await alice.createDocument('contracts');
    await alice.proposeSchema(
      'contracts',
      'Message',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      { expectedVersion: 'new' },
    );
    await alice.proposeSchema(
      'contracts',
      'MessageList',
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
        },
        required: ['items'],
      },
      { expectedVersion: 'new' },
    );
    await bob.acceptSchema('contracts', 'Message');

    const buckets = await collectBuckets(alice, 'contracts', 'alice');
    const messageList = buckets.awaitingPeer.find((r) => r.label === 'MessageList');
    expect(messageList?.blockedOn).toEqual([]);
  });

  it('annotates endpoint proposals that $ref unaccepted schemas', async () => {
    // The blocked state is "schema exists as proposed but isn't accepted yet". A schema
    // that doesn't exist at all causes the propose itself to fail validation (dangling
    // ref) — so propose User first, then propose an endpoint that refs it.
    await alice.createDocument('contracts');
    await alice.proposeSchema(
      'contracts',
      'User',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      { expectedVersion: 'new' },
    );
    await alice.proposeEndpoint(
      'contracts',
      'get',
      '/users/{id}',
      {
        summary: 'Get a user',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/User' } },
            },
          },
        },
      },
      { expectedVersion: 'new' },
    );

    const buckets = await collectBuckets(alice, 'contracts', 'alice');
    const endpoint = buckets.awaitingPeer.find((r) => r.kind === 'endpoint');
    expect(endpoint?.label).toBe('GET /users/{id}');
    expect(endpoint?.blockedOn).toEqual(['User']);
  });
});

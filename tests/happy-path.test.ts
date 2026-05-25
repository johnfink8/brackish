// End-to-end full journey: walks the skill's prescribed flow through every
// substantive transition once — propose, batch-propose, reject + counter-propose,
// withdraw, accept with rationale, diff across rejected/accepted versions, and
// visualize. Models what the chat-app trial exercises with real Claude
// sub-processes, but deterministically and in ~100ms.
//
// Two identities:
//   alice — server-side, creates the doc over socket (becomes owner)
//   bob   — client-side, redeems an invite over TCP (becomes member via --grant)
//
// One big `it` block on purpose — failures surface exactly where in the skill's
// flow the system breaks down, in order.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectBuckets } from '../src/cli/status.js';
import { BrackishClient, ClientError, redeemInvite } from '../src/client/client.js';
import { type RunningServer, startServer } from '../src/daemon/server.js';

describe('happy-path: skill journey from doc-grant to visualize', () => {
  let tmp: string;
  let server: RunningServer;
  let alice: BrackishClient; // socket — owner
  let bob: BrackishClient; // TCP — member via invite --grant
  let tcpUrl: string;
  const savedHome = process.env.BRACKISH_HOME;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'brackish-happy-'));
    process.env.BRACKISH_HOME = tmp;
    server = await startServer({
      config: {
        socketPath: join(tmp, 'brackish.sock'),
        dataPath: join(tmp, 'brackish.db'),
        bind: '127.0.0.1:0',
      },
    });
    if (!server.tcpAddress) throw new Error('expected TCP bind');
    tcpUrl = `http://127.0.0.1:${server.tcpAddress.port}`;
    alice = new BrackishClient({ socketPath: server.socketPath, identity: 'alice' });
  });

  afterEach(async () => {
    await alice.close();
    if (bob) await bob.close();
    await server.close();
    if (savedHome !== undefined) process.env.BRACKISH_HOME = savedHome;
    else delete process.env.BRACKISH_HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('full journey: doc grant, batch propose, reject+counter-propose schema and endpoint, withdraw, diff, visualize', async () => {
    // ===== Phase 1: alice creates the doc (owner via auto-grant) =====
    const doc = await alice.createDocument('chat-api');
    expect(doc.createdBy).toBe('alice');

    const initialMembers = await alice.listMembers('chat-api');
    expect(initialMembers).toHaveLength(1);
    expect(initialMembers[0]?.identity).toBe('alice');
    expect(initialMembers[0]?.role).toBe('owner');

    // ===== Phase 2: alice mints invite with --grant; bob redeems over TCP =====
    const invite = await alice.createInvite('bob', 3600, ['chat-api']);
    expect(invite.identity).toBe('bob');

    const redeemed = await redeemInvite(tcpUrl, invite.inviteToken);
    expect(redeemed.identity).toBe('bob');
    bob = new BrackishClient({ server: tcpUrl, token: redeemed.token });

    expect((await bob.whoami()).identity).toBe('bob');
    const bobDocs = await bob.listDocuments();
    expect(bobDocs.map((d) => d.name)).toEqual(['chat-api']);

    // ===== Phase 2.5: alice claims scope via `brackish send` =====
    // Per server.md Step 2: scope-claim chat message is the highest-leverage move
    // for avoiding duplicate-name collisions and out-of-scope churn.
    const scopeMsg = await alice.sendMessage(
      'chat-api',
      "I'm the API server. Scope: chat-api — User/Message + GET/POST messages. JWT bearer auth.",
    );
    expect(scopeMsg.kind).toBe('message');
    await alice.deliver('chat-api'); // events are held until delivered (one turn = one batch)

    // bob's inbox should pick up the scope claim immediately (one new message).
    const inboxAfterScope = await bob.inbox();
    const chatEntry = inboxAfterScope.documents.find((d) => d.documentName === 'chat-api');
    expect(chatEntry?.newCount).toBeGreaterThan(0);
    expect(chatEntry?.lastKind).toBe('message');
    expect(chatEntry?.lastFrom).toBe('alice');
    expect(chatEntry?.preview).toContain('Scope');

    // ===== Phase 3: convention propose + accept =====
    await alice.proposeConvention(
      'chat-api',
      {
        info: { title: 'Chat API', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
      },
      { expectedVersion: 'new' },
    );
    expect((await bob.acceptConvention('chat-api')).status).toBe('accepted');

    // ===== Phase 4: batch-propose User + Message + MessageList (mutual refs) =====
    const batchRes = await alice.proposeBatch('chat-api', {
      schemas: [
        {
          name: 'Message',
          spec: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              body: { type: 'string' },
              author: { $ref: '#/components/schemas/User' },
            },
            required: ['id', 'body', 'author'],
          },
        },
        {
          name: 'User',
          spec: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
            required: ['id'],
          },
        },
        {
          name: 'MessageList',
          spec: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
            },
            required: ['items'],
          },
        },
      ],
    });
    expect(batchRes.succeeded.map((s) => s.kind === 'schema' && s.name)).toEqual([
      'Message',
      'User',
      'MessageList',
    ]);

    // ===== Phase 5: bob reads status — sees blocked-on annotations =====
    const initialStatus = await collectBuckets(bob, 'chat-api', 'bob');
    expect(initialStatus.awaitingMe.find((r) => r.label === 'Message')?.blockedOn).toEqual([
      'User',
    ]);
    expect(initialStatus.awaitingMe.find((r) => r.label === 'MessageList')?.blockedOn).toEqual([
      'Message',
    ]);
    expect(initialStatus.awaitingMe.find((r) => r.label === 'User')?.blockedOn).toEqual([]);

    // ===== Phase 5.5: bob reads the proposed Message body before deciding =====
    // The skill teaches `<kind> show <doc> <id>` for grounding before accept/reject; the
    // CLI returns tagged accepted+proposed with body inline. Here we exercise the
    // BrackishClient's lower-level getSchema({proposed:true}) which the CLI uses internally.
    const proposedMessage = await bob.getSchema('chat-api', 'Message', { proposed: true });
    expect(proposedMessage.status).toBe('proposed');
    expect(proposedMessage.version).toBe(1);

    // ===== Phase 6: bob accepts User (no refs, so unblocked) =====
    await bob.acceptSchema('chat-api', 'User');

    // ===== Phase 7: bob rejects Message v1 with reason =====
    // The chat-app trial's defining moment: frontend rejected backend's Message
    // because it lacked render-readiness fields. We mirror that here.
    const rejectedMessage = await bob.rejectSchema(
      'chat-api',
      'Message',
      'needs `created_at` — every chat row needs to display when the message landed',
    );
    expect(rejectedMessage.status).toBe('rejected');
    if (rejectedMessage.status === 'rejected') {
      expect(rejectedMessage.rejectionReason).toContain('created_at');
    }

    // ===== Phase 8: alice withdraws MessageList v1 =====
    // Its $ref:Message is rejected — accepting MessageList right now would 400 on
    // validation. Alice pulls it back to re-propose after Message v2 lands.
    const withdrawn = await alice.withdrawSchema('chat-api', 'MessageList');
    expect(withdrawn.status).toBe('rejected'); // withdraw marks the version rejected
    if (withdrawn.status === 'rejected') {
      expect(withdrawn.rejectionReason).toBe('withdrawn by proposer');
    }

    // ===== Phase 8.5: alice's stale --expected-version 0 propose fails with 409 =====
    // Race-protection negative path the skill warns about. Latest version of Message
    // is 1 (rejected); passing expected-version 0 (or 'new') must 409 version_mismatch.
    await expect(
      alice.proposeSchema(
        'chat-api',
        'Message',
        { type: 'object', properties: { id: { type: 'string' } } },
        { expectedVersion: 'new' },
      ),
    ).rejects.toBeInstanceOf(ClientError);

    // ===== Phase 9: alice counter-proposes Message v2 with --expected-version 1 =====
    const messageV2 = await alice.proposeSchema(
      'chat-api',
      'Message',
      {
        type: 'object',
        properties: {
          id: { type: 'string' },
          body: { type: 'string' },
          author: { $ref: '#/components/schemas/User' },
          created_at: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'body', 'author', 'created_at'],
      },
      { expectedVersion: 1 },
    );
    expect(messageV2.version).toBe(2);
    expect(messageV2.status).toBe('proposed');

    // ===== Phase 10: bob accepts Message v2 with --rationale =====
    const acceptedMessage = await bob.acceptSchema(
      'chat-api',
      'Message',
      undefined,
      'created_at gives us absolute ordering + display, agreed',
    );
    expect(acceptedMessage.status).toBe('accepted');
    expect(acceptedMessage.version).toBe(2);

    // ===== Phase 11: alice re-proposes MessageList v2 (after its withdrawal) =====
    const messageListV2 = await alice.proposeSchema(
      'chat-api',
      'MessageList',
      {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
          next_cursor: { type: 'string' },
        },
        required: ['items'],
      },
      { expectedVersion: 1 },
    );
    expect(messageListV2.version).toBe(2);

    // ===== Phase 12: bob accepts MessageList v2 =====
    await bob.acceptSchema('chat-api', 'MessageList');

    // Sanity: all three schemas + convention are now accepted, nothing in-flight.
    const midStatus = await collectBuckets(bob, 'chat-api', 'bob');
    expect(midStatus.awaitingMe).toEqual([]);
    expect(midStatus.awaitingPeer).toEqual([]);
    expect(midStatus.accepted.map((r) => r.label).sort()).toEqual([
      'Message',
      'MessageList',
      'User',
      'convention',
    ]);

    // ===== Phase 13: alice proposes GET /messages v1 (bare array) =====
    await alice.proposeEndpoint(
      'chat-api',
      'get',
      '/messages',
      {
        summary: 'List recent messages',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
              },
            },
          },
        },
      },
      { expectedVersion: 'new' },
    );

    // ===== Phase 14: bob rejects v1 with reason =====
    await bob.rejectEndpoint(
      'chat-api',
      'get',
      '/messages',
      'need MessageList envelope for cursor pagination, not a bare array',
    );

    // ===== Phase 15: alice counter-proposes v2 with --expected-version 1 =====
    const endpointV2 = await alice.proposeEndpoint(
      'chat-api',
      'get',
      '/messages',
      {
        summary: 'List recent messages',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MessageList' } },
            },
          },
        },
      },
      { expectedVersion: 1 },
    );
    expect(endpointV2.version).toBe(2);

    // ===== Phase 16: bob accepts v2 with rationale (carried on event) =====
    const acceptedEndpoint = await bob.acceptEndpoint(
      'chat-api',
      'get',
      '/messages',
      undefined,
      'envelope shape matches MessageList',
    );
    expect(acceptedEndpoint.status).toBe('accepted');
    expect(acceptedEndpoint.version).toBe(2);

    // Verify both rationales rode on their accept events. Deliver both sides' held events first
    // (the event stream spans alice's proposes + bob's accepts).
    await alice.deliver('chat-api');
    await bob.deliver('chat-api');
    const events = await bob.listEvents('chat-api');
    const messageAcceptEvent = events.events.find(
      (e) => e.kind === 'artifact_accepted' && e.identityKey === 'Message' && e.version === 2,
    );
    if (messageAcceptEvent && messageAcceptEvent.kind === 'artifact_accepted') {
      expect(messageAcceptEvent.reason).toContain('created_at');
    }
    const endpointAcceptEvent = events.events.find(
      (e) => e.kind === 'artifact_accepted' && e.identityKey === 'GET /messages' && e.version === 2,
    );
    if (endpointAcceptEvent && endpointAcceptEvent.kind === 'artifact_accepted') {
      expect(endpointAcceptEvent.reason).toBe('envelope shape matches MessageList');
    }

    // ===== Phase 17: diff GET /messages v1 → v2 (rejected → accepted) =====
    const endpointDiff = await bob.diffEndpoint('chat-api', 'get', '/messages');
    expect(endpointDiff.fromVersion).toBe(1);
    expect(endpointDiff.toVersion).toBe(2);
    expect(endpointDiff.patch.length).toBeGreaterThan(0);

    // ===== Phase 18: diff Message v1 → v2 (rejected → accepted schema revision) =====
    const schemaDiff = await bob.diffSchema('chat-api', 'Message');
    expect(schemaDiff.fromVersion).toBe(1);
    expect(schemaDiff.toVersion).toBe(2);
    // The patch should mention `created_at` (the field added in v2).
    expect(JSON.stringify(schemaDiff.patch)).toContain('created_at');

    // ===== Phase 19: visualize assembles the final OpenAPI doc =====
    const finalDoc = await bob.getOpenApiJson('chat-api');
    expect(finalDoc.openapi).toBe('3.1.0');
    expect(finalDoc.info.title).toBe('Chat API');
    expect(finalDoc.paths['/messages']?.get).toBeDefined();
    const messageSchema = finalDoc.components?.schemas?.Message as {
      properties: Record<string, unknown>;
    };
    expect(messageSchema.properties.created_at).toBeDefined();

    const yaml = await bob.getOpenApiYaml('chat-api');
    expect(yaml).toContain('openapi: 3.1.0');
    expect(yaml).toContain('MessageList');
    expect(yaml).toContain('created_at');

    // ===== Phase 19.5: `brackish read --tail N` peeks the last N events without cursor advance =====
    // The skill teaches --tail for cheap end-of-log scans. Cursor must stay where it was
    // so a follow-up read-from-cursor still picks up the unread tail.
    const cursorBefore = await bob.listEvents('chat-api', { tail: 1 });
    const tailRes = await bob.listEvents('chat-api', { tail: 3 });
    expect(tailRes.events).toHaveLength(3);
    expect(tailRes.cursor).toBe(cursorBefore.cursor); // tail doesn't advance the cursor

    // ===== Phase 20: bob drains cursor; inbox is empty (read-before-nap) =====
    await bob.listEvents('chat-api');
    const finalInbox = await bob.inbox();
    expect(finalInbox.documents.filter((d) => d.documentName === 'chat-api')).toEqual([]);
  });

  it('admin verbs: alice grants observer, lists members, revokes', async () => {
    // The happy-path journey above gets observer-style access via invite --grant.
    // This test exercises the *direct* admin verbs the skill exposes for adding
    // a third peer (e.g. a reviewer joining mid-flight) — `brackish doc grant`,
    // `brackish doc members`, `brackish doc revoke`.
    await alice.createDocument('admin-test');

    // Grant observer membership directly (no invite, no token — alice does this
    // over socket as the owner, applying ACL at the API level).
    await alice.addMember('admin-test', 'observer', 'member');

    const members = await alice.listMembers('admin-test');
    const names = members.map((m) => m.identity).sort();
    expect(names).toEqual(['alice', 'observer']);
    const observerRow = members.find((m) => m.identity === 'observer');
    expect(observerRow?.role).toBe('member');
    expect(observerRow?.grantedBy).toBe('alice');

    // Revoke removes the membership row.
    await alice.removeMember('admin-test', 'observer');
    const after = await alice.listMembers('admin-test');
    expect(after.map((m) => m.identity)).toEqual(['alice']);
  });
});

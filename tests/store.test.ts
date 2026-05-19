import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventNotifier } from '../src/notifier.js';
import { SqliteStore, StoreError } from '../src/store/sqlite.js';

describe('SqliteStore', () => {
  let store: SqliteStore;
  let notifier: EventNotifier;

  beforeEach(() => {
    notifier = new EventNotifier();
    store = new SqliteStore({ path: ':memory:', notifier });
  });

  afterEach(async () => {
    await store.close();
  });

  describe('documents', () => {
    it('create + get round-trips', async () => {
      const t = await store.createDocument('contracts', 'host');
      expect(t.name).toBe('contracts');
      expect(t.createdBy).toBe('host');
      const fetched = await store.getDocument('contracts');
      expect(fetched).toEqual(t);
    });

    it('rejects duplicate document names', async () => {
      await store.createDocument('contracts', 'host');
      await expect(store.createDocument('contracts', 'host')).rejects.toMatchObject({
        code: 'document_exists',
      });
    });

    it('emits a document_created event', async () => {
      await store.createDocument('contracts', 'host');
      const events = await store.listEvents('contracts', 0, 100);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('document_created');
    });

    it('listDocuments returns in creation order', async () => {
      await store.createDocument('a', 'host');
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct timestamps
      await store.createDocument('b', 'host');
      const list = await store.listDocuments();
      expect(list.map((t) => t.name)).toEqual(['a', 'b']);
    });
  });

  describe('messages and events', () => {
    beforeEach(async () => {
      await store.createDocument('t', 'host');
    });

    it('appendMessage returns a typed event and notifier fires', async () => {
      let fired = false;
      notifier.register('t', () => {
        fired = true;
      });
      const evt = await store.appendMessage('t', 'host', 'hello');
      expect(evt.kind).toBe('message');
      expect(evt.id).toBeGreaterThan(0);
      if (evt.kind === 'message') {
        expect(evt.text).toBe('hello');
        expect(evt.from).toBe('host');
      }
      expect(fired).toBe(true);
    });

    it('listEvents honors since cursor (exclusive lower bound)', async () => {
      const e1 = await store.appendMessage('t', 'host', 'first');
      const e2 = await store.appendMessage('t', 'host', 'second');
      const e3 = await store.appendMessage('t', 'host', 'third');
      const fromMid = await store.listEvents('t', e1.id, 100);
      expect(fromMid.map((e) => e.id)).toEqual([e2.id, e3.id]);
      const fromHead = await store.listEvents('t', e3.id, 100);
      expect(fromHead).toEqual([]);
    });

    it('listEvents respects limit', async () => {
      for (let i = 0; i < 5; i++) await store.appendMessage('t', 'host', `m${i}`);
      const limited = await store.listEvents('t', 0, 2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });

    it('latestCursor reflects highest event id', async () => {
      expect(await store.latestCursor('t')).toBeGreaterThan(0); // document_created event
      const before = await store.latestCursor('t');
      const m = await store.appendMessage('t', 'host', 'hi');
      expect(await store.latestCursor('t')).toBe(m.id);
      expect(m.id).toBeGreaterThan(before);
    });

    it('appendMessage rejects unknown documents', async () => {
      await expect(store.appendMessage('nope', 'host', 'x')).rejects.toMatchObject({
        code: 'document_not_found',
      });
    });
  });


  describe('parties and tokens', () => {
    it('ensureParty is idempotent', async () => {
      const p1 = await store.ensureParty('alice');
      const p2 = await store.ensureParty('alice');
      expect(p1.identity).toBe('alice');
      expect(p1.createdAt).toBe(p2.createdAt);
    });

    it('revokeParty removes the party and cascades to tokens', async () => {
      const invite = await store.createInvite('alice', 3600);
      const { token } = await store.redeemInvite(invite.token);
      expect(await store.getIdentityForToken(token)).toBe('alice');
      await store.revokeParty('alice');
      expect(await store.getIdentityForToken(token)).toBeNull();
    });

    it('touchPartySeen updates last_seen_at', async () => {
      await store.ensureParty('alice');
      await store.touchPartySeen('alice');
      const parties = await store.listParties();
      expect(parties[0]?.lastSeenAt).not.toBeNull();
    });
  });

  describe('invites', () => {
    it('redeemInvite issues a persistent token and binds it to identity', async () => {
      const inv = await store.createInvite('alice', 3600);
      const { identity, token } = await store.redeemInvite(inv.token);
      expect(identity).toBe('alice');
      expect(token.length).toBeGreaterThan(20);
      expect(await store.getIdentityForToken(token)).toBe('alice');
    });

    it('redeeming an unknown invite is rejected', async () => {
      await expect(store.redeemInvite('bogus')).rejects.toMatchObject({
        code: 'invite_invalid',
      });
    });

    it('redeeming twice is rejected', async () => {
      const inv = await store.createInvite('alice', 3600);
      await store.redeemInvite(inv.token);
      await expect(store.redeemInvite(inv.token)).rejects.toMatchObject({
        code: 'invite_redeemed',
      });
    });

    it('redeeming an expired invite is rejected', async () => {
      const inv = await store.createInvite('alice', 0); // already-expired window
      await new Promise((r) => setTimeout(r, 5));
      await expect(store.redeemInvite(inv.token)).rejects.toMatchObject({
        code: 'invite_expired',
      });
    });
  });

  describe('cursors', () => {
    beforeEach(async () => {
      await store.createDocument('t', 'host');
    });

    it('getLastSeenCursor defaults to 0', async () => {
      expect(await store.getLastSeenCursor('alice', 't')).toBe(0);
    });

    it('advanceCursor sets and is monotonic', async () => {
      await store.advanceCursor('alice', 't', 10);
      expect(await store.getLastSeenCursor('alice', 't')).toBe(10);
      await store.advanceCursor('alice', 't', 5); // stale, should not regress
      expect(await store.getLastSeenCursor('alice', 't')).toBe(10);
      await store.advanceCursor('alice', 't', 25);
      expect(await store.getLastSeenCursor('alice', 't')).toBe(25);
    });

    it('cursors are per (identity, document)', async () => {
      await store.createDocument('u', 'host');
      await store.advanceCursor('alice', 't', 10);
      expect(await store.getLastSeenCursor('alice', 't')).toBe(10);
      expect(await store.getLastSeenCursor('alice', 'u')).toBe(0);
      expect(await store.getLastSeenCursor('bob', 't')).toBe(0);
    });
  });

  describe('inbox summary', () => {
    it('lists only documents with events newer than identity cursor', async () => {
      await store.createDocument('a', 'host');
      await store.createDocument('b', 'host');
      await store.appendMessage('a', 'host', 'first in a');
      await store.appendMessage('b', 'host', 'first in b');
      // alice has seen up to a's first event
      const aEvents = await store.listEvents('a', 0, 100);
      const lastA = aEvents[aEvents.length - 1];
      if (!lastA) throw new Error('expected events in a');
      await store.advanceCursor('alice', 'a', lastA.id);

      const inbox = await store.inboxSummary('alice');
      const names = inbox.map((e) => e.documentName);
      expect(names).toContain('b');
      expect(names).not.toContain('a');
    });

    it('preview reflects the last event content', async () => {
      await store.createDocument('a', 'host');
      await store.appendMessage('a', 'peer', 'hello there from peer');
      const inbox = await store.inboxSummary('alice');
      const a = inbox.find((e) => e.documentName === 'a');
      expect(a?.preview).toContain('hello');
      expect(a?.lastFrom).toBe('peer');
      expect(a?.lastKind).toBe('message');
    });

    it('newCount reflects events past the identity cursor', async () => {
      await store.createDocument('a', 'host');
      await store.appendMessage('a', 'host', 'one');
      await store.appendMessage('a', 'host', 'two');
      await store.appendMessage('a', 'host', 'three');
      const inbox = await store.inboxSummary('alice');
      // document_created + 3 messages = 4 events, all past cursor 0
      expect(inbox[0]?.newCount).toBe(4);
    });
  });
});

// Make sure the error class is usable for typed assertions.
describe('StoreError', () => {
  it('carries a code and message', () => {
    const e = new StoreError('test_code', 'test message');
    expect(e.code).toBe('test_code');
    expect(e.message).toBe('test message');
    expect(e instanceof Error).toBe(true);
  });
});

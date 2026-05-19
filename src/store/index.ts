// Persistence interface. Implementations: SQLite (default, in ./sqlite.ts); future Postgres / Redis
// adapters slot in behind this same surface. All methods are async; sync-internally impls just don't await.
//
// Long-poll WAIT is NOT a method here — it's implemented at the server layer by combining
// `listEvents` (after-the-fact catch-up) with `EventNotifier` (live fan-out). The store's only
// obligation is to call `notifier.notify(threadName)` after a successful append.

import type {
  ArtifactKind,
  ArtifactName,
  ArtifactSummary,
  ArtifactVersion,
  Cursor,
  Event,
  Identity,
  InboxEntry,
  Invite,
  Party,
  Thread,
  ThreadName,
} from '../models.js';

export interface Store {
  // --- threads ---
  createThread(name: ThreadName, by: Identity): Promise<Thread>;
  getThread(name: ThreadName): Promise<Thread | null>;
  listThreads(): Promise<Thread[]>;

  // --- events ---
  /** Append a `message` event. Returns the persisted event with its assigned id. */
  appendMessage(threadName: ThreadName, from: Identity, text: string): Promise<Event>;
  /** Returns events strictly greater than `since`, up to `limit`. */
  listEvents(threadName: ThreadName, since: Cursor, limit: number): Promise<Event[]>;
  /** Highest event id currently stored for a thread. Used to size the cursor. */
  latestCursor(threadName: ThreadName): Promise<Cursor>;

  // --- artifacts ---
  proposeArtifact(
    threadName: ThreadName,
    name: ArtifactName,
    kind: ArtifactKind,
    content: string,
    by: Identity,
  ): Promise<ArtifactVersion>;
  acceptArtifact(
    threadName: ThreadName,
    name: ArtifactName,
    version: number,
    by: Identity,
  ): Promise<ArtifactVersion>;
  rejectArtifact(
    threadName: ThreadName,
    name: ArtifactName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<ArtifactVersion>;
  /** Latest accepted version. `null` if no version has been accepted yet. */
  getArtifactCurrent(threadName: ThreadName, name: ArtifactName): Promise<ArtifactVersion | null>;
  /** Latest proposed-but-not-yet-resolved version. */
  getArtifactProposed(threadName: ThreadName, name: ArtifactName): Promise<ArtifactVersion | null>;
  getArtifactByVersion(
    threadName: ThreadName,
    name: ArtifactName,
    version: number,
  ): Promise<ArtifactVersion | null>;
  listArtifacts(threadName: ThreadName): Promise<ArtifactSummary[]>;

  // --- parties / TCP auth ---
  /** Resolve identity from a persistent token (TCP auth path). */
  getIdentityForToken(token: string): Promise<Identity | null>;
  /** Ensure a party row exists; used by socket peer-trust to lazily register identities. */
  ensureParty(identity: Identity): Promise<Party>;
  listParties(): Promise<Party[]>;
  revokeParty(identity: Identity): Promise<void>;
  touchPartySeen(identity: Identity): Promise<void>;

  // --- invites ---
  createInvite(identity: Identity, ttlSeconds: number): Promise<Invite>;
  /** Atomically redeem an unexpired invite; returns the (identity, persistent token) it yielded. */
  redeemInvite(inviteToken: string): Promise<{ identity: Identity; token: string }>;

  // --- cursors (server-tracked per (identity, thread)) ---
  getLastSeenCursor(identity: Identity, threadName: ThreadName): Promise<Cursor>;
  /** Advance to `cursor` iff strictly greater; idempotent on stale or out-of-order calls. */
  advanceCursor(identity: Identity, threadName: ThreadName, cursor: Cursor): Promise<void>;

  // --- inbox (cross-thread summary for one identity) ---
  inboxSummary(identity: Identity): Promise<InboxEntry[]>;

  // --- lifecycle ---
  close(): Promise<void>;
}

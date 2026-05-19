// Persistence interface. Implementations: SQLite (default, in ./sqlite.ts); future Postgres / Redis
// adapters slot in behind this same surface. All methods are async; sync-internally impls just don't await.
//
// Long-poll WAIT is NOT a method here — it's implemented at the server layer by combining
// `listEvents` (after-the-fact catch-up) with `EventNotifier` (live fan-out). The store's only
// obligation is to call `notifier.notify(documentName)` after a successful append.

import type {
  ArtifactKind,
  ArtifactName,
  ArtifactSummary,
  ArtifactVersion,
  Cursor,
  Document,
  DocumentName,
  Event,
  Identity,
  InboxEntry,
  Invite,
  Party,
} from '../models.js';

export interface Store {
  // --- documents ---
  createDocument(name: DocumentName, by: Identity): Promise<Document>;
  getDocument(name: DocumentName): Promise<Document | null>;
  listDocuments(): Promise<Document[]>;

  // --- events ---
  /** Append a `message` event. Returns the persisted event with its assigned id. */
  appendMessage(documentName: DocumentName, from: Identity, text: string): Promise<Event>;
  /** Returns events strictly greater than `since`, up to `limit`. */
  listEvents(documentName: DocumentName, since: Cursor, limit: number): Promise<Event[]>;
  /** Highest event id currently stored for a document. Used to size the cursor. */
  latestCursor(documentName: DocumentName): Promise<Cursor>;

  // --- artifacts ---
  proposeArtifact(
    documentName: DocumentName,
    name: ArtifactName,
    kind: ArtifactKind,
    content: string,
    by: Identity,
  ): Promise<ArtifactVersion>;
  acceptArtifact(
    documentName: DocumentName,
    name: ArtifactName,
    version: number,
    by: Identity,
  ): Promise<ArtifactVersion>;
  rejectArtifact(
    documentName: DocumentName,
    name: ArtifactName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<ArtifactVersion>;
  /** Latest accepted version. `null` if no version has been accepted yet. */
  getArtifactCurrent(
    documentName: DocumentName,
    name: ArtifactName,
  ): Promise<ArtifactVersion | null>;
  /** Latest proposed-but-not-yet-resolved version. */
  getArtifactProposed(
    documentName: DocumentName,
    name: ArtifactName,
  ): Promise<ArtifactVersion | null>;
  getArtifactByVersion(
    documentName: DocumentName,
    name: ArtifactName,
    version: number,
  ): Promise<ArtifactVersion | null>;
  listArtifacts(documentName: DocumentName): Promise<ArtifactSummary[]>;

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

  // --- cursors (server-tracked per (identity, document)) ---
  getLastSeenCursor(identity: Identity, documentName: DocumentName): Promise<Cursor>;
  /** Advance to `cursor` iff strictly greater; idempotent on stale or out-of-order calls. */
  advanceCursor(identity: Identity, documentName: DocumentName, cursor: Cursor): Promise<void>;

  // --- inbox (cross-document summary for one identity) ---
  inboxSummary(identity: Identity): Promise<InboxEntry[]>;

  // --- lifecycle ---
  close(): Promise<void>;
}

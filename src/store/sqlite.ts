// better-sqlite3 implementation of the Store interface.
//
// Schema philosophy: events are an append-only log; documents + artifact_versions are projections.
// One writer (single-process Node); WAL for concurrent reads. better-sqlite3 is sync — methods
// return Promises only because the Store interface is async to keep open a path to Postgres later.

import { randomBytes } from 'node:crypto';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  type ArtifactKind,
  type ArtifactName,
  type ArtifactSummary,
  type ArtifactVersion,
  type Cursor,
  type Document,
  type DocumentName,
  type Event,
  EventSchema,
  type Identity,
  type InboxEntry,
  type Invite,
  type Party,
} from '../models.js';
import type { EventNotifier } from '../notifier.js';
import type { Store } from './index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  name        TEXT PRIMARY KEY,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_name  TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_document_id_idx ON events(document_name, id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  document_name       TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  version           INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  proposed_by       TEXT NOT NULL,
  proposed_at       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
  accepted_by       TEXT,
  accepted_at       TEXT,
  rejected_by       TEXT,
  rejected_at       TEXT,
  rejection_reason  TEXT,
  PRIMARY KEY (document_name, name, version)
);
CREATE INDEX IF NOT EXISTS artifact_versions_lookup_idx
  ON artifact_versions(document_name, name, status, version);

CREATE TABLE IF NOT EXISTS parties (
  identity      TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS party_tokens (
  token       TEXT PRIMARY KEY,
  identity    TEXT NOT NULL REFERENCES parties(identity) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS party_tokens_identity_idx ON party_tokens(identity);

CREATE TABLE IF NOT EXISTS invites (
  token        TEXT PRIMARY KEY,
  identity     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  redeemed_at  TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  identity     TEXT NOT NULL,
  document_name  TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (identity, document_name)
);
`;

type EventRow = {
  id: number;
  document_name: string;
  kind: string;
  created_at: string;
  data: string;
};

type ArtifactRow = {
  document_name: string;
  name: string;
  version: number;
  kind: string;
  content: string;
  proposed_by: string;
  proposed_at: string;
  status: 'proposed' | 'accepted' | 'rejected';
  accepted_by: string | null;
  accepted_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
};

type DocumentRow = { name: string; created_by: string; created_at: string };
type PartyRow = { identity: string; created_at: string; last_seen_at: string | null };
type InviteRow = {
  token: string;
  identity: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
};

const now = (): string => new Date().toISOString();
const newToken = (): string => randomBytes(32).toString('base64url');

export class SqliteStore implements Store {
  private readonly db: DatabaseType;
  private readonly notifier: EventNotifier;

  constructor(opts: { path: string; notifier: EventNotifier }) {
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.notifier = opts.notifier;
  }

  // --- helpers ---

  private rowToDocument(row: DocumentRow): Document {
    return { name: row.name, createdBy: row.created_by, createdAt: row.created_at };
  }

  private rowToEvent(row: EventRow): Event {
    return EventSchema.parse({
      id: row.id,
      documentName: row.document_name,
      createdAt: row.created_at,
      kind: row.kind,
      ...(JSON.parse(row.data) as Record<string, unknown>),
    });
  }

  private rowToArtifactVersion(row: ArtifactRow): ArtifactVersion {
    const base = {
      documentName: row.document_name,
      name: row.name,
      version: row.version,
      kind: row.kind,
      content: row.content,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
    };
    if (row.status === 'proposed') {
      return { ...base, status: 'proposed' };
    }
    if (row.status === 'accepted') {
      if (row.accepted_by === null || row.accepted_at === null) {
        throw new Error(`accepted artifact ${row.name}@${row.version} missing accepted_by/at`);
      }
      return {
        ...base,
        status: 'accepted',
        acceptedBy: row.accepted_by,
        acceptedAt: row.accepted_at,
      };
    }
    if (row.rejected_by === null || row.rejected_at === null || row.rejection_reason === null) {
      throw new Error(`rejected artifact ${row.name}@${row.version} missing rejected_by/at/reason`);
    }
    return {
      ...base,
      status: 'rejected',
      rejectedBy: row.rejected_by,
      rejectedAt: row.rejected_at,
      rejectionReason: row.rejection_reason,
    };
  }

  /** Insert an event row, return the materialized Event, and notify subscribers. */
  private insertEvent(documentName: DocumentName, kind: string, data: object): Event {
    const createdAt = now();
    const result = this.db
      .prepare('INSERT INTO events (document_name, kind, created_at, data) VALUES (?, ?, ?, ?)')
      .run(documentName, kind, createdAt, JSON.stringify(data));
    const id = Number(result.lastInsertRowid);
    const event = this.rowToEvent({
      id,
      document_name: documentName,
      kind,
      created_at: createdAt,
      data: JSON.stringify(data),
    });
    this.notifier.notify(documentName);
    return event;
  }

  // --- documents ---

  async createDocument(name: DocumentName, by: Identity): Promise<Document> {
    const existing = this.db
      .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE name = ?')
      .get(name);
    if (existing) {
      throw new StoreError('document_exists', `document "${name}" already exists`);
    }
    const tx = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO documents (name, created_by, created_at) VALUES (?, ?, ?)')
        .run(name, by, now());
      this.insertEvent(name, 'document_created', { by });
    });
    tx();
    const row = this.db
      .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE name = ?')
      .get(name);
    if (!row) throw new Error('createDocument: row missing after insert');
    return this.rowToDocument(row);
  }

  async getDocument(name: DocumentName): Promise<Document | null> {
    const row = this.db
      .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE name = ?')
      .get(name);
    return row ? this.rowToDocument(row) : null;
  }

  async listDocuments(): Promise<Document[]> {
    const rows = this.db
      .prepare<[], DocumentRow>('SELECT * FROM documents ORDER BY created_at')
      .all();
    return rows.map((r) => this.rowToDocument(r));
  }

  // --- events ---

  async appendMessage(documentName: DocumentName, from: Identity, text: string): Promise<Event> {
    const document = await this.getDocument(documentName);
    if (!document)
      throw new StoreError('document_not_found', `document "${documentName}" not found`);
    return this.insertEvent(documentName, 'message', { from, text });
  }

  async listEvents(documentName: DocumentName, since: Cursor, limit: number): Promise<Event[]> {
    const rows = this.db
      .prepare<[string, number, number], EventRow>(
        'SELECT * FROM events WHERE document_name = ? AND id > ? ORDER BY id LIMIT ?',
      )
      .all(documentName, since, limit);
    return rows.map((r) => this.rowToEvent(r));
  }

  async latestCursor(documentName: DocumentName): Promise<Cursor> {
    const row = this.db
      .prepare<[string], { max_id: number | null }>(
        'SELECT COALESCE(MAX(id), 0) AS max_id FROM events WHERE document_name = ?',
      )
      .get(documentName);
    return row?.max_id ?? 0;
  }

  // --- artifacts ---

  async proposeArtifact(
    documentName: DocumentName,
    name: ArtifactName,
    kind: ArtifactKind,
    content: string,
    by: Identity,
  ): Promise<ArtifactVersion> {
    const document = await this.getDocument(documentName);
    if (!document)
      throw new StoreError('document_not_found', `document "${documentName}" not found`);

    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare<[string, string], { max_v: number | null }>(
          'SELECT MAX(version) AS max_v FROM artifact_versions WHERE document_name = ? AND name = ?',
        )
        .get(documentName, name);
      const version = (maxRow?.max_v ?? 0) + 1;
      const proposedAt = now();
      this.db
        .prepare(
          `INSERT INTO artifact_versions
             (document_name, name, version, kind, content, proposed_by, proposed_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')`,
        )
        .run(documentName, name, version, kind, content, by, proposedAt);
      this.insertEvent(documentName, 'artifact_proposed', {
        from: by,
        artifactName: name,
        artifactKind: kind,
        version,
      });
      row = this.db
        .prepare<[string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND name = ? AND version = ?',
        )
        .get(documentName, name, version);
    });
    tx();
    if (!row) throw new Error('proposeArtifact: row missing after insert');
    return this.rowToArtifactVersion(row);
  }

  async acceptArtifact(
    documentName: DocumentName,
    name: ArtifactName,
    version: number,
    by: Identity,
  ): Promise<ArtifactVersion> {
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND name = ? AND version = ?',
        )
        .get(documentName, name, version);
      if (!existing) {
        throw new StoreError('artifact_not_found', `artifact ${name}@${version} not found`);
      }
      if (existing.status !== 'proposed') {
        throw new StoreError(
          'artifact_not_pending',
          `artifact ${name}@${version} is ${existing.status}, not proposed`,
        );
      }
      if (existing.proposed_by === by) {
        throw new StoreError(
          'cannot_accept_own',
          `${by} cannot accept their own proposal of ${name}@${version}`,
        );
      }
      const acceptedAt = now();
      this.db
        .prepare(
          `UPDATE artifact_versions
             SET status = 'accepted', accepted_by = ?, accepted_at = ?
             WHERE document_name = ? AND name = ? AND version = ?`,
        )
        .run(by, acceptedAt, documentName, name, version);
      this.insertEvent(documentName, 'artifact_accepted', {
        from: by,
        artifactName: name,
        version,
      });
      row = this.db
        .prepare<[string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND name = ? AND version = ?',
        )
        .get(documentName, name, version);
    });
    tx();
    if (!row) throw new Error('acceptArtifact: row missing after update');
    return this.rowToArtifactVersion(row);
  }

  async rejectArtifact(
    documentName: DocumentName,
    name: ArtifactName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<ArtifactVersion> {
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND name = ? AND version = ?',
        )
        .get(documentName, name, version);
      if (!existing) {
        throw new StoreError('artifact_not_found', `artifact ${name}@${version} not found`);
      }
      if (existing.status !== 'proposed') {
        throw new StoreError(
          'artifact_not_pending',
          `artifact ${name}@${version} is ${existing.status}, not proposed`,
        );
      }
      if (existing.proposed_by === by) {
        throw new StoreError(
          'cannot_reject_own',
          `${by} cannot reject their own proposal of ${name}@${version}`,
        );
      }
      const rejectedAt = now();
      this.db
        .prepare(
          `UPDATE artifact_versions
             SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?
             WHERE document_name = ? AND name = ? AND version = ?`,
        )
        .run(by, rejectedAt, reason, documentName, name, version);
      this.insertEvent(documentName, 'artifact_rejected', {
        from: by,
        artifactName: name,
        version,
        reason,
      });
      row = this.db
        .prepare<[string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND name = ? AND version = ?',
        )
        .get(documentName, name, version);
    });
    tx();
    if (!row) throw new Error('rejectArtifact: row missing after update');
    return this.rowToArtifactVersion(row);
  }

  async getArtifactCurrent(
    documentName: DocumentName,
    name: ArtifactName,
  ): Promise<ArtifactVersion | null> {
    const row = this.db
      .prepare<[string, string], ArtifactRow>(
        `SELECT * FROM artifact_versions
         WHERE document_name = ? AND name = ? AND status = 'accepted'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(documentName, name);
    return row ? this.rowToArtifactVersion(row) : null;
  }

  async getArtifactProposed(
    documentName: DocumentName,
    name: ArtifactName,
  ): Promise<ArtifactVersion | null> {
    const row = this.db
      .prepare<[string, string], ArtifactRow>(
        `SELECT * FROM artifact_versions
         WHERE document_name = ? AND name = ? AND status = 'proposed'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(documentName, name);
    return row ? this.rowToArtifactVersion(row) : null;
  }

  async getArtifactByVersion(
    documentName: DocumentName,
    name: ArtifactName,
    version: number,
  ): Promise<ArtifactVersion | null> {
    const row = this.db
      .prepare<[string, string, number], ArtifactRow>(
        'SELECT * FROM artifact_versions WHERE document_name = ? AND name = ? AND version = ?',
      )
      .get(documentName, name, version);
    return row ? this.rowToArtifactVersion(row) : null;
  }

  async listArtifacts(documentName: DocumentName): Promise<ArtifactSummary[]> {
    const rows = this.db
      .prepare<[string], ArtifactRow>(
        'SELECT * FROM artifact_versions WHERE document_name = ? ORDER BY name, version',
      )
      .all(documentName);
    const byName = new Map<string, ArtifactRow[]>();
    for (const r of rows) {
      const list = byName.get(r.name);
      if (list) list.push(r);
      else byName.set(r.name, [r]);
    }
    const summaries: ArtifactSummary[] = [];
    for (const [name, versions] of byName) {
      const accepted = [...versions].reverse().find((v) => v.status === 'accepted');
      const proposed = [...versions].reverse().find((v) => v.status === 'proposed');
      const latest = versions[versions.length - 1];
      if (!latest) continue;
      summaries.push({
        name,
        kind: latest.kind,
        currentVersion: accepted ? accepted.version : null,
        currentAcceptedAt: accepted?.accepted_at ?? null,
        latestProposedVersion: proposed ? proposed.version : null,
        latestProposedBy: proposed ? proposed.proposed_by : null,
        latestProposedAt: proposed ? proposed.proposed_at : null,
      });
    }
    return summaries;
  }

  // --- parties / TCP auth ---

  async getIdentityForToken(token: string): Promise<Identity | null> {
    const row = this.db
      .prepare<[string], { identity: string }>('SELECT identity FROM party_tokens WHERE token = ?')
      .get(token);
    return row ? row.identity : null;
  }

  async ensureParty(identity: Identity): Promise<Party> {
    this.db
      .prepare(
        `INSERT INTO parties (identity, created_at, last_seen_at)
         VALUES (?, ?, NULL)
         ON CONFLICT(identity) DO NOTHING`,
      )
      .run(identity, now());
    const row = this.db
      .prepare<[string], PartyRow>('SELECT * FROM parties WHERE identity = ?')
      .get(identity);
    if (!row) throw new Error('ensureParty: row missing after upsert');
    return {
      identity: row.identity,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  async listParties(): Promise<Party[]> {
    const rows = this.db.prepare<[], PartyRow>('SELECT * FROM parties ORDER BY created_at').all();
    return rows.map((r) => ({
      identity: r.identity,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  async revokeParty(identity: Identity): Promise<void> {
    // CASCADE deletes party_tokens and cursors automatically.
    this.db.prepare('DELETE FROM parties WHERE identity = ?').run(identity);
  }

  async touchPartySeen(identity: Identity): Promise<void> {
    this.db.prepare('UPDATE parties SET last_seen_at = ? WHERE identity = ?').run(now(), identity);
  }

  // --- invites ---

  async createInvite(identity: Identity, ttlSeconds: number): Promise<Invite> {
    const token = newToken();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare('INSERT INTO invites (token, identity, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, identity, createdAt, expiresAt);
    return { token, identity, createdAt, expiresAt };
  }

  async redeemInvite(inviteToken: string): Promise<{ identity: Identity; token: string }> {
    let issued: { identity: Identity; token: string } | undefined;
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], InviteRow>('SELECT * FROM invites WHERE token = ?')
        .get(inviteToken);
      if (!row) throw new StoreError('invite_invalid', 'invite token not recognized');
      if (row.redeemed_at !== null) {
        throw new StoreError('invite_redeemed', 'invite already redeemed');
      }
      if (Date.parse(row.expires_at) < Date.now()) {
        throw new StoreError('invite_expired', 'invite has expired');
      }
      this.db
        .prepare(
          `INSERT INTO parties (identity, created_at, last_seen_at)
           VALUES (?, ?, NULL)
           ON CONFLICT(identity) DO NOTHING`,
        )
        .run(row.identity, now());
      const persistentToken = newToken();
      this.db
        .prepare('INSERT INTO party_tokens (token, identity, created_at) VALUES (?, ?, ?)')
        .run(persistentToken, row.identity, now());
      this.db.prepare('UPDATE invites SET redeemed_at = ? WHERE token = ?').run(now(), inviteToken);
      issued = { identity: row.identity, token: persistentToken };
    });
    tx();
    if (!issued) throw new Error('redeemInvite: issued token missing after tx');
    return issued;
  }

  // --- cursors ---

  async getLastSeenCursor(identity: Identity, documentName: DocumentName): Promise<Cursor> {
    const row = this.db
      .prepare<[string, string], { last_seen: number }>(
        'SELECT last_seen FROM cursors WHERE identity = ? AND document_name = ?',
      )
      .get(identity, documentName);
    return row?.last_seen ?? 0;
  }

  async advanceCursor(
    identity: Identity,
    documentName: DocumentName,
    cursor: Cursor,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO cursors (identity, document_name, last_seen)
         VALUES (?, ?, ?)
         ON CONFLICT(identity, document_name) DO UPDATE
           SET last_seen = excluded.last_seen
           WHERE excluded.last_seen > cursors.last_seen`,
      )
      .run(identity, documentName, cursor);
  }

  // --- inbox ---

  async inboxSummary(identity: Identity): Promise<InboxEntry[]> {
    // Documents with at least one event newer than the identity's cursor.
    const rows = this.db
      .prepare<
        { identity: string },
        { document_name: string; new_count: number; last_seen: number }
      >(
        `SELECT t.name AS document_name,
                (SELECT COUNT(*) FROM events e
                   WHERE e.document_name = t.name
                   AND e.id > COALESCE(
                     (SELECT last_seen FROM cursors
                        WHERE identity = @identity AND document_name = t.name),
                     0
                   )
                ) AS new_count,
                COALESCE(
                  (SELECT last_seen FROM cursors
                     WHERE identity = @identity AND document_name = t.name),
                  0
                ) AS last_seen
         FROM documents t`,
      )
      .all({ identity });
    const entries: InboxEntry[] = [];
    for (const r of rows) {
      if (r.new_count <= 0) continue;
      const lastRow = this.db
        .prepare<[string], EventRow>(
          `SELECT * FROM events
           WHERE document_name = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(r.document_name);
      if (!lastRow) continue;
      const lastEvent = this.rowToEvent(lastRow);
      entries.push({
        documentName: r.document_name,
        newCount: r.new_count,
        lastEventAt: lastEvent.createdAt,
        lastFrom: 'from' in lastEvent ? lastEvent.from : null,
        lastKind: lastEvent.kind,
        preview: previewOf(lastEvent),
      });
    }
    return entries;
  }

  // --- lifecycle ---

  async close(): Promise<void> {
    this.db.close();
  }
}

function previewOf(e: Event): string {
  switch (e.kind) {
    case 'message':
      return truncate(e.text, 80);
    case 'artifact_proposed':
      return `proposed ${e.artifactName}@${e.version} (${e.artifactKind})`;
    case 'artifact_accepted':
      return `accepted ${e.artifactName}@${e.version}`;
    case 'artifact_rejected':
      return `rejected ${e.artifactName}@${e.version}: ${truncate(e.reason, 60)}`;
    case 'document_created':
      return `document created by ${e.by}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

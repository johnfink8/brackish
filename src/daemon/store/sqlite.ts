// better-sqlite3 implementation of the v0.2 Store interface.
//
// Schema philosophy: events are an append-only log; documents + artifact_versions are projections.
// One writer (single-process Node); WAL for concurrent reads. better-sqlite3 is sync — methods
// return Promises only because the Store interface is async to keep open a path to Postgres later.
//
// Artifacts are kind-discriminated (operation / schema / convention). Identity scheme:
//   operation:  identity_key = '<METHOD> <path>'         (e.g. 'POST /users')
//   schema:     identity_key = '<NAME>'                  (e.g. 'User')
//   convention: identity_key = 'convention' (singleton)
//
// `delta` is stored on each version v≥2 as a compact "+a; -b; ~c" summary computed via the diff
// module against the previous version's spec. It's surfaced in event payloads + summaries so
// callers can decide whether to fetch the full spec.

import { createHash, randomBytes } from 'node:crypto';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { compactSummary, generatePatch } from '../../lib/diff.js';
import {
  CONVENTION_KEY,
  type ConventionArtifact,
  ConventionArtifactSchema,
  type ConventionSpec,
  type Cursor,
  type Document,
  type DocumentName,
  type EndpointSummary,
  type Event,
  EventSchema,
  type HttpMethod,
  type Identity,
  type InboxEntry,
  type Invite,
  type JSONSchema,
  type OperationArtifact,
  OperationArtifactSchema,
  type OperationSpec,
  operationIdentityKey,
  type Party,
  parseOperationIdentityKey,
  type SchemaArtifact,
  SchemaArtifactSchema,
  type SchemaName,
  type SchemaSummary,
} from '../../lib/models.js';
import type { EventNotifier } from '../../lib/notifier.js';
import type {
  BatchProposeInput,
  BatchProposeSucceededItem,
  ProposeOptions,
  RationaleEntry,
  Store,
} from './index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  name        TEXT PRIMARY KEY,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_name TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_document_id_idx ON events(document_name, id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  document_name    TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('operation','schema','convention')),
  identity_key     TEXT NOT NULL,
  version          INTEGER NOT NULL,
  spec             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
  proposed_by      TEXT NOT NULL,
  proposed_at      TEXT NOT NULL,
  accepted_by      TEXT,
  accepted_at      TEXT,
  rejected_by      TEXT,
  rejected_at      TEXT,
  rejection_reason TEXT,
  delta            TEXT,
  PRIMARY KEY (document_name, kind, identity_key, version)
);
CREATE INDEX IF NOT EXISTS artifact_versions_lookup_idx
  ON artifact_versions(document_name, kind, identity_key, status, version);

CREATE TABLE IF NOT EXISTS parties (
  identity      TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- party_tokens.token_hash stores sha256(raw token). The raw token only ever
-- lives on the peer (in their config.toml) and in transit (Bearer header);
-- the daemon never persists it. See migration in SqliteStore constructor for
-- the v1→v2 in-place upgrade path.
CREATE TABLE IF NOT EXISTS party_tokens (
  token_hash  TEXT PRIMARY KEY,
  identity    TEXT NOT NULL REFERENCES parties(identity) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS party_tokens_identity_idx ON party_tokens(identity);

-- Same hashing scheme for invites: the daemon stores only sha256(inviteToken).
CREATE TABLE IF NOT EXISTS invites (
  token_hash   TEXT PRIMARY KEY,
  identity     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  redeemed_at  TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  identity      TEXT NOT NULL,
  document_name TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (identity, document_name)
);

-- One-row schema-version tracker. Gates startup migrations.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-document ACL. Socket peers (peer-trust) bypass this; TCP peers must be members.
-- Document creators are inserted as 'owner' by createDocument; additional members can be
-- added via the membership API or auto-granted at invite redemption.
CREATE TABLE IF NOT EXISTS document_members (
  document_name TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  identity      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','member')),
  granted_by    TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  PRIMARY KEY (document_name, identity)
);
CREATE INDEX IF NOT EXISTS document_members_identity_idx ON document_members(identity);

-- Optional document grants attached to an invite. Redeeming the invite inserts the
-- new party as a 'member' of each named doc.
CREATE TABLE IF NOT EXISTS invite_grants (
  token_hash    TEXT NOT NULL,
  document_name TEXT NOT NULL,
  PRIMARY KEY (token_hash, document_name)
);



CREATE TABLE IF NOT EXISTS ui_sessions (
  token_hash    TEXT PRIMARY KEY,
  identity      TEXT NOT NULL REFERENCES parties(identity) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('ott','cookie')),
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS ui_sessions_identity_idx ON ui_sessions(identity);
`;

const SCHEMA_VERSION = 3;

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

/** Parse a stored ISO datetime; treat anything unparseable as "expired" (fail-closed).
 *  Replaces the pre-fix `Date.parse(s) < Date.now()` pattern that returned false for
 *  NaN, leaving malformed `expires_at` columns silently redeemable. */
function isExpired(iso: string): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  return t < Date.now();
}

type EventRow = {
  id: number;
  document_name: string;
  kind: string;
  created_at: string;
  data: string;
};

type ArtifactRow = {
  document_name: string;
  kind: 'operation' | 'schema' | 'convention';
  identity_key: string;
  version: number;
  spec: string;
  status: 'proposed' | 'accepted' | 'rejected';
  proposed_by: string;
  proposed_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  delta: string | null;
};

type DocumentRow = { name: string; created_by: string; created_at: string };
type PartyRow = { identity: string; created_at: string; last_seen_at: string | null };
type InviteRow = {
  token_hash: string;
  identity: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
};

const now = (): string => new Date().toISOString();
const newToken = (): string => randomBytes(32).toString('base64url');

/** Typed JSON.parse — narrows `any` to `unknown` at the boundary so callers must zod-validate
 *  before using the result. The data we read here was JSON.stringify'd by us on the way in,
 *  but the column is still untrusted from the type system's perspective. */
function parseJson(s: string): unknown {
  return JSON.parse(s);
}

/** Schema for the JSON-stringified `events.data` column: always a plain object spread into the
 *  outer Event envelope by rowToEvent. */
const JsonObjectSchema = z.record(z.string(), z.unknown());

export class SqliteStore implements Store {
  private readonly db: DatabaseType;
  private readonly notifier: EventNotifier;

  constructor(opts: { path: string; notifier: EventNotifier }) {
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    // Migrate any pre-v2 schema (raw `token` columns) to v2 (sha256 `token_hash`)
    // BEFORE applying SCHEMA — the CREATE TABLE IF NOT EXISTS statements would skip
    // the rebuild on an existing DB, and we need the old shape readable to migrate it.
    this.migrateLegacyTokenColumns();
    this.db.exec(SCHEMA);
    this.migrateOwnershipFromCreatedBy();
    this.recordSchemaVersion();
    this.notifier = opts.notifier;
  }

  /** v2 → v3 ACL migration: each existing document gets its `created_by` recorded as an
   *  owner in document_members. Pre-existing TCP peers who were globally-trusted before
   *  must now be granted explicitly — a breaking change documented in 0.6.0 CHANGELOG. */
  private migrateOwnershipFromCreatedBy(): void {
    const versionRow = this.db
      .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    const current = versionRow ? Number.parseInt(versionRow.value, 10) : 0;
    if (current >= 3) return;
    const docs = this.db
      .prepare<[], { name: string; created_by: string; created_at: string }>(
        'SELECT name, created_by, created_at FROM documents',
      )
      .all();
    const insert = this.db.prepare(
      `INSERT INTO document_members (document_name, identity, role, granted_by, granted_at)
       VALUES (?, ?, 'owner', ?, ?)
       ON CONFLICT(document_name, identity) DO NOTHING`,
    );
    const tx = this.db.transaction(() => {
      for (const d of docs) {
        insert.run(d.name, d.created_by, d.created_by, d.created_at);
      }
    });
    tx();
  }

  /** v1 → v2 token migration: rebuild party_tokens and invites with hashed primary keys,
   *  carrying forward the existing rows by hashing their raw `token` columns. Idempotent —
   *  no-op when the meta row already says v2, or when the legacy tables don't exist (fresh
   *  install). */
  private migrateLegacyTokenColumns(): void {
    // Bootstrap the meta table eagerly so we can read schema_version even on first run.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    );
    const versionRow = this.db
      .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    const current = versionRow ? Number.parseInt(versionRow.value, 10) : 0;
    if (current >= SCHEMA_VERSION) return;
    const partyCols = this.tableColumns('party_tokens');
    const inviteCols = this.tableColumns('invites');
    const partyHasRaw = partyCols.includes('token') && !partyCols.includes('token_hash');
    const inviteHasRaw = inviteCols.includes('token') && !inviteCols.includes('token_hash');
    if (!partyHasRaw && !inviteHasRaw) return; // fresh install or already migrated

    const tx = this.db.transaction(() => {
      if (partyHasRaw) {
        const rows = this.db
          .prepare<[], { token: string; identity: string; created_at: string }>(
            'SELECT token, identity, created_at FROM party_tokens',
          )
          .all();
        this.db.exec('DROP TABLE party_tokens');
        this.db.exec(
          `CREATE TABLE party_tokens (
             token_hash TEXT PRIMARY KEY,
             identity TEXT NOT NULL REFERENCES parties(identity) ON DELETE CASCADE,
             created_at TEXT NOT NULL
           );
           CREATE INDEX party_tokens_identity_idx ON party_tokens(identity);`,
        );
        const insert = this.db.prepare(
          'INSERT INTO party_tokens (token_hash, identity, created_at) VALUES (?, ?, ?)',
        );
        for (const r of rows) insert.run(hashToken(r.token), r.identity, r.created_at);
      }
      if (inviteHasRaw) {
        const rows = this.db
          .prepare<
            [],
            {
              token: string;
              identity: string;
              created_at: string;
              expires_at: string;
              redeemed_at: string | null;
            }
          >('SELECT token, identity, created_at, expires_at, redeemed_at FROM invites')
          .all();
        this.db.exec('DROP TABLE invites');
        this.db.exec(
          `CREATE TABLE invites (
             token_hash TEXT PRIMARY KEY,
             identity TEXT NOT NULL,
             created_at TEXT NOT NULL,
             expires_at TEXT NOT NULL,
             redeemed_at TEXT
           );`,
        );
        const insert = this.db.prepare(
          'INSERT INTO invites (token_hash, identity, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, ?, ?)',
        );
        for (const r of rows) {
          insert.run(hashToken(r.token), r.identity, r.created_at, r.expires_at, r.redeemed_at);
        }
      }
    });
    tx();
  }

  private tableColumns(table: string): string[] {
    const rows = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info('${table}')`)
      .all();
    return rows.map((r) => r.name);
  }

  private recordSchemaVersion(): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(SCHEMA_VERSION));
  }

  // --- helpers ---

  private rowToDocument(row: DocumentRow): Document {
    return { name: row.name, createdBy: row.created_by, createdAt: row.created_at };
  }

  private rowToEvent(row: EventRow): Event {
    const dataObj = JsonObjectSchema.parse(parseJson(row.data));
    return EventSchema.parse({
      id: row.id,
      documentName: row.document_name,
      createdAt: row.created_at,
      kind: row.kind,
      ...dataObj,
    });
  }

  /** Build the status-specific fields common to all artifact-version envelopes. */
  private statusFieldsFromRow(row: ArtifactRow): Record<string, unknown> {
    const base = {
      version: row.version,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
    };
    if (row.status === 'proposed') return { ...base, status: 'proposed' };
    if (row.status === 'accepted') {
      if (row.accepted_by === null || row.accepted_at === null) {
        throw new Error(
          `accepted artifact ${row.identity_key}@v${row.version} missing accepted_by/at`,
        );
      }
      return {
        ...base,
        status: 'accepted',
        acceptedBy: row.accepted_by,
        acceptedAt: row.accepted_at,
      };
    }
    if (row.rejected_by === null || row.rejected_at === null || row.rejection_reason === null) {
      throw new Error(
        `rejected artifact ${row.identity_key}@v${row.version} missing rejected_by/at/reason`,
      );
    }
    return {
      ...base,
      status: 'rejected',
      rejectedBy: row.rejected_by,
      rejectedAt: row.rejected_at,
      rejectionReason: row.rejection_reason,
    };
  }

  private rowToOperationArtifact(row: ArtifactRow): OperationArtifact {
    if (row.kind !== 'operation') throw new Error(`expected operation, got ${row.kind}`);
    const { method, path } = parseOperationIdentityKey(row.identity_key);
    return OperationArtifactSchema.parse({
      kind: 'operation',
      documentName: row.document_name,
      method,
      path,
      spec: parseJson(row.spec),
      ...this.statusFieldsFromRow(row),
    });
  }

  private rowToSchemaArtifact(row: ArtifactRow): SchemaArtifact {
    if (row.kind !== 'schema') throw new Error(`expected schema, got ${row.kind}`);
    return SchemaArtifactSchema.parse({
      kind: 'schema',
      documentName: row.document_name,
      name: row.identity_key,
      spec: parseJson(row.spec),
      ...this.statusFieldsFromRow(row),
    });
  }

  private rowToConventionArtifact(row: ArtifactRow): ConventionArtifact {
    if (row.kind !== 'convention') throw new Error(`expected convention, got ${row.kind}`);
    return ConventionArtifactSchema.parse({
      kind: 'convention',
      documentName: row.document_name,
      spec: parseJson(row.spec),
      ...this.statusFieldsFromRow(row),
    });
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

  /** Fetch the latest version row for (document, kind, identity_key) regardless of status — used
   *  to compute the delta when a new proposal lands. */
  private latestVersionRow(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
  ): ArtifactRow | undefined {
    return this.db
      .prepare<[string, string, string], ArtifactRow>(
        `SELECT * FROM artifact_versions
         WHERE document_name = ? AND kind = ? AND identity_key = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(documentName, kind, identityKey);
  }

  /** Generic propose for any kind. Computes the delta vs previous version (any status). */
  private proposeRaw(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
    spec: unknown,
    by: Identity,
    opts: ProposeOptions = {},
  ): ArtifactRow {
    const document = this.db
      .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE name = ?')
      .get(documentName);
    if (!document) {
      throw new StoreError('document_not_found', `document "${documentName}" not found`);
    }
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const prev = this.latestVersionRow(documentName, kind, identityKey);
      const prevVersion = prev?.version ?? 0;

      // Concurrency check. Three modes:
      //   expectedVersion === 'new'  → must be no prior version at all.
      //   expectedVersion === number → latest must be exactly that version (any status).
      //   neither → default behavior, refuse if latest is in-flight (still `proposed`)
      //             unless `force`.
      if (opts.expectedVersion === 'new') {
        if (prev !== undefined) {
          throw new StoreError(
            'version_mismatch',
            `--expected-new failed: ${kind} "${identityKey}" already at v${prevVersion} (${prev.status} by ${prev.proposed_by}). Review it (\`brackish ${kind === 'operation' ? 'endpoint' : kind} show\`) before proposing.`,
          );
        }
      } else if (typeof opts.expectedVersion === 'number') {
        if (prevVersion !== opts.expectedVersion) {
          throw new StoreError(
            'version_mismatch',
            `--expected-version ${opts.expectedVersion} failed: ${kind} "${identityKey}" latest is v${prevVersion}${prev ? ` (${prev.status} by ${prev.proposed_by})` : ' (none)'}. Re-read state and retry.`,
          );
        }
      } else if (prev?.status === 'proposed' && !opts.force) {
        throw new StoreError(
          'version_in_flight',
          `${kind} "${identityKey}" v${prevVersion} is still proposed by ${prev.proposed_by} and unresolved. Accept/reject it first, or pass --force to stack a counter-proposal.`,
        );
      }

      const version = prevVersion + 1;
      const delta =
        prev !== undefined
          ? compactSummary(generatePatch(parseJson(prev.spec), spec)) || '(no change)'
          : null;
      const proposedAt = now();
      this.db
        .prepare(
          `INSERT INTO artifact_versions
             (document_name, kind, identity_key, version, spec, status, proposed_by, proposed_at, delta)
           VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
        )
        .run(documentName, kind, identityKey, version, JSON.stringify(spec), by, proposedAt, delta);
      this.insertEvent(documentName, 'artifact_proposed', {
        from: by,
        artifactKind: kind,
        identityKey,
        version,
        delta,
      });
      row = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
    });
    tx();
    if (!row) throw new Error('proposeRaw: row missing after insert');
    return row;
  }

  /** Generic accept for any kind. */
  private acceptRaw(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
    version: number,
    by: Identity,
    reason?: string,
  ): ArtifactRow {
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
      if (!existing) {
        throw new StoreError('artifact_not_found', `${kind} ${identityKey}@v${version} not found`);
      }
      if (existing.status !== 'proposed') {
        throw new StoreError(
          'artifact_not_pending',
          `${kind} ${identityKey}@v${version} is ${existing.status}, not proposed`,
        );
      }
      if (existing.proposed_by === by) {
        throw new StoreError(
          'cannot_accept_own',
          `${by} cannot accept their own proposal of ${kind} ${identityKey}@v${version}`,
        );
      }
      const acceptedAt = now();
      this.db
        .prepare(
          `UPDATE artifact_versions
             SET status = 'accepted', accepted_by = ?, accepted_at = ?
             WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?`,
        )
        .run(by, acceptedAt, documentName, kind, identityKey, version);
      this.insertEvent(documentName, 'artifact_accepted', {
        from: by,
        artifactKind: kind,
        identityKey,
        version,
        ...(reason !== undefined ? { reason } : {}),
      });
      row = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
    });
    tx();
    if (!row) throw new Error('acceptRaw: row missing after update');
    return row;
  }

  /** Generic reject for any kind. */
  private rejectRaw(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
    version: number,
    reason: string,
    by: Identity,
  ): ArtifactRow {
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
      if (!existing) {
        throw new StoreError('artifact_not_found', `${kind} ${identityKey}@v${version} not found`);
      }
      if (existing.status !== 'proposed') {
        throw new StoreError(
          'artifact_not_pending',
          `${kind} ${identityKey}@v${version} is ${existing.status}, not proposed`,
        );
      }
      if (existing.proposed_by === by) {
        throw new StoreError(
          'cannot_reject_own',
          `${by} cannot reject their own proposal of ${kind} ${identityKey}@v${version}`,
        );
      }
      const rejectedAt = now();
      this.db
        .prepare(
          `UPDATE artifact_versions
             SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?
             WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?`,
        )
        .run(by, rejectedAt, reason, documentName, kind, identityKey, version);
      this.insertEvent(documentName, 'artifact_rejected', {
        from: by,
        artifactKind: kind,
        identityKey,
        version,
        reason,
      });
      row = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
    });
    tx();
    if (!row) throw new Error('rejectRaw: row missing after update');
    return row;
  }

  /** Self-withdraw a still-proposed version. Marks it rejected with reason
   *  `withdrawn by proposer` and emits an `artifact_withdrawn` event for visibility. */
  private withdrawRaw(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
    version: number,
    by: Identity,
  ): ArtifactRow {
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
      if (!existing) {
        throw new StoreError('artifact_not_found', `${kind} ${identityKey}@v${version} not found`);
      }
      if (existing.status !== 'proposed') {
        throw new StoreError(
          'artifact_not_pending',
          `${kind} ${identityKey}@v${version} is ${existing.status}, only proposed versions can be withdrawn`,
        );
      }
      if (existing.proposed_by !== by) {
        throw new StoreError(
          'cannot_withdraw_others',
          `${by} cannot withdraw ${kind} ${identityKey}@v${version} — it was proposed by ${existing.proposed_by}`,
        );
      }
      const rejectedAt = now();
      this.db
        .prepare(
          `UPDATE artifact_versions
             SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?
             WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?`,
        )
        .run(by, rejectedAt, 'withdrawn by proposer', documentName, kind, identityKey, version);
      this.insertEvent(documentName, 'artifact_withdrawn', {
        from: by,
        artifactKind: kind,
        identityKey,
        version,
      });
      row = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
    });
    tx();
    if (!row) throw new Error('withdrawRaw: row missing after update');
    return row;
  }

  private getRaw(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
    selector: { version?: number; status?: 'accepted' | 'proposed' },
  ): ArtifactRow | undefined {
    if (selector.version !== undefined) {
      return this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, selector.version);
    }
    const status = selector.status ?? 'accepted';
    return this.db
      .prepare<[string, string, string, string], ArtifactRow>(
        `SELECT * FROM artifact_versions
         WHERE document_name = ? AND kind = ? AND identity_key = ? AND status = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(documentName, kind, identityKey, status);
  }

  /** Build a summary (current/proposed/delta) from the version rows for one identity key. */
  private buildSummary(rows: ArtifactRow[]): {
    currentVersion: number | null;
    currentAcceptedAt: string | null;
    latestProposedVersion: number | null;
    latestProposedBy: Identity | null;
    latestProposedAt: string | null;
    latestDelta: string | null;
  } {
    const accepted = [...rows].reverse().find((r) => r.status === 'accepted');
    const proposed = [...rows].reverse().find((r) => r.status === 'proposed');
    return {
      currentVersion: accepted ? accepted.version : null,
      currentAcceptedAt: accepted?.accepted_at ?? null,
      latestProposedVersion: proposed ? proposed.version : null,
      latestProposedBy: proposed ? proposed.proposed_by : null,
      latestProposedAt: proposed ? proposed.proposed_at : null,
      latestDelta: proposed?.delta ?? null,
    };
  }

  private buildRationale(rows: ArtifactRow[]): RationaleEntry[] {
    return rows
      .slice()
      .sort((a, b) => a.version - b.version)
      .map((r) => {
        let spec: unknown = null;
        try {
          spec = parseJson(r.spec);
        } catch {
          // Should never happen — spec was JSON.stringify'd on the way in.
        }
        const entry: RationaleEntry = {
          version: r.version,
          status: r.status,
          proposedBy: r.proposed_by,
          proposedAt: r.proposed_at,
          delta: r.delta,
          spec,
        };
        if (r.accepted_by) entry.acceptedBy = r.accepted_by;
        if (r.accepted_at) entry.acceptedAt = r.accepted_at;
        if (r.rejected_by) entry.rejectedBy = r.rejected_by;
        if (r.rejected_at) entry.rejectedAt = r.rejected_at;
        if (r.rejection_reason) entry.rejectionReason = r.rejection_reason;
        return entry;
      });
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
      const createdAt = now();
      this.db
        .prepare('INSERT INTO documents (name, created_by, created_at) VALUES (?, ?, ?)')
        .run(name, by, createdAt);
      // Creator becomes owner; TCP-side ACL gating uses this row.
      this.db
        .prepare(
          `INSERT INTO document_members (document_name, identity, role, granted_by, granted_at)
           VALUES (?, ?, 'owner', ?, ?)`,
        )
        .run(name, by, by, createdAt);
      this.insertEvent(name, 'document_created', { by });
    });
    tx();
    const row = this.db
      .prepare<[string], DocumentRow>('SELECT * FROM documents WHERE name = ?')
      .get(name);
    if (!row) throw new Error('createDocument: row missing after insert');
    return this.rowToDocument(row);
  }

  // --- ACL ---

  async isMember(documentName: DocumentName, identity: Identity): Promise<boolean> {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        'SELECT COUNT(*) AS c FROM document_members WHERE document_name = ? AND identity = ?',
      )
      .get(documentName, identity);
    return (row?.c ?? 0) > 0;
  }

  async listDocumentsForMember(identity: Identity): Promise<Document[]> {
    const rows = this.db
      .prepare<[string], DocumentRow>(
        `SELECT d.* FROM documents d
         JOIN document_members m ON m.document_name = d.name
         WHERE m.identity = ?
         ORDER BY d.created_at`,
      )
      .all(identity);
    return rows.map((r) => this.rowToDocument(r));
  }

  async addDocumentMember(
    documentName: DocumentName,
    identity: Identity,
    role: 'owner' | 'member',
    grantedBy: Identity,
  ): Promise<void> {
    const document = await this.getDocument(documentName);
    if (!document) {
      throw new StoreError('document_not_found', `document "${documentName}" not found`);
    }
    this.db
      .prepare(
        `INSERT INTO document_members (document_name, identity, role, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(document_name, identity) DO UPDATE SET
           role = excluded.role,
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at`,
      )
      .run(documentName, identity, role, grantedBy, now());
  }

  async removeDocumentMember(
    documentName: DocumentName,
    identity: Identity,
  ): Promise<void> {
    this.db
      .prepare('DELETE FROM document_members WHERE document_name = ? AND identity = ?')
      .run(documentName, identity);
  }

  async listDocumentMembers(
    documentName: DocumentName,
  ): Promise<Array<{ identity: Identity; role: 'owner' | 'member'; grantedBy: Identity; grantedAt: string }>> {
    const rows = this.db
      .prepare<
        [string],
        { identity: string; role: 'owner' | 'member'; granted_by: string; granted_at: string }
      >(
        'SELECT identity, role, granted_by, granted_at FROM document_members WHERE document_name = ? ORDER BY granted_at',
      )
      .all(documentName);
    return rows.map((r) => ({
      identity: r.identity,
      role: r.role,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    }));
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

  async listLastEvents(documentName: DocumentName, limit: number): Promise<Event[]> {
    // Reverse-fetch the tail in id-DESC order then flip to chronological — keeps the response
    // shape identical to listEvents (oldest first).
    const rows = this.db
      .prepare<[string, number], EventRow>(
        'SELECT * FROM events WHERE document_name = ? ORDER BY id DESC LIMIT ?',
      )
      .all(documentName, limit);
    return rows.reverse().map((r) => this.rowToEvent(r));
  }

  async latestCursor(documentName: DocumentName): Promise<Cursor> {
    const row = this.db
      .prepare<[string], { max_id: number | null }>(
        'SELECT COALESCE(MAX(id), 0) AS max_id FROM events WHERE document_name = ?',
      )
      .get(documentName);
    return row?.max_id ?? 0;
  }

  // --- endpoint artifacts ---

  async proposeEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    spec: OperationSpec,
    by: Identity,
    opts: ProposeOptions = {},
  ): Promise<OperationArtifact> {
    const row = this.proposeRaw(
      documentName,
      'operation',
      operationIdentityKey(method, path),
      spec,
      by,
      opts,
    );
    return this.rowToOperationArtifact(row);
  }

  async acceptEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    by: Identity,
    reason?: string,
  ): Promise<OperationArtifact> {
    return this.rowToOperationArtifact(
      this.acceptRaw(
        documentName,
        'operation',
        operationIdentityKey(method, path),
        version,
        by,
        reason,
      ),
    );
  }

  async rejectEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<OperationArtifact> {
    return this.rowToOperationArtifact(
      this.rejectRaw(
        documentName,
        'operation',
        operationIdentityKey(method, path),
        version,
        reason,
        by,
      ),
    );
  }

  async withdrawEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    by: Identity,
  ): Promise<OperationArtifact> {
    return this.rowToOperationArtifact(
      this.withdrawRaw(documentName, 'operation', operationIdentityKey(method, path), version, by),
    );
  }

  async getEndpointCurrent(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
  ): Promise<OperationArtifact | null> {
    const row = this.getRaw(documentName, 'operation', operationIdentityKey(method, path), {
      status: 'accepted',
    });
    return row ? this.rowToOperationArtifact(row) : null;
  }

  async getEndpointProposed(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
  ): Promise<OperationArtifact | null> {
    const row = this.getRaw(documentName, 'operation', operationIdentityKey(method, path), {
      status: 'proposed',
    });
    return row ? this.rowToOperationArtifact(row) : null;
  }

  async getEndpointByVersion(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
  ): Promise<OperationArtifact | null> {
    const row = this.getRaw(documentName, 'operation', operationIdentityKey(method, path), {
      version,
    });
    return row ? this.rowToOperationArtifact(row) : null;
  }

  async listEndpoints(documentName: DocumentName): Promise<EndpointSummary[]> {
    const rows = this.db
      .prepare<[string], ArtifactRow>(
        "SELECT * FROM artifact_versions WHERE document_name = ? AND kind = 'operation' ORDER BY identity_key, version",
      )
      .all(documentName);
    const byKey = new Map<string, ArtifactRow[]>();
    for (const r of rows) {
      const list = byKey.get(r.identity_key);
      if (list) list.push(r);
      else byKey.set(r.identity_key, [r]);
    }
    const out: EndpointSummary[] = [];
    for (const [key, versions] of byKey) {
      const { method, path } = parseOperationIdentityKey(key);
      const accepted = [...versions].reverse().find((r) => r.status === 'accepted');
      let summary: string | null = null;
      if (accepted) {
        try {
          const spec = parseJson(accepted.spec);
          if (
            typeof spec === 'object' &&
            spec !== null &&
            'summary' in spec &&
            typeof spec.summary === 'string'
          ) {
            summary = spec.summary;
          }
        } catch {
          /* ignore */
        }
      }
      out.push({
        method,
        path,
        summary,
        ...this.buildSummary(versions),
      });
    }
    return out;
  }

  // --- schema artifacts ---

  async proposeSchema(
    documentName: DocumentName,
    name: SchemaName,
    spec: JSONSchema,
    by: Identity,
    opts: ProposeOptions = {},
  ): Promise<SchemaArtifact> {
    return this.rowToSchemaArtifact(this.proposeRaw(documentName, 'schema', name, spec, by, opts));
  }

  async acceptSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    by: Identity,
    reason?: string,
  ): Promise<SchemaArtifact> {
    return this.rowToSchemaArtifact(
      this.acceptRaw(documentName, 'schema', name, version, by, reason),
    );
  }

  async rejectSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<SchemaArtifact> {
    return this.rowToSchemaArtifact(
      this.rejectRaw(documentName, 'schema', name, version, reason, by),
    );
  }

  async withdrawSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    by: Identity,
  ): Promise<SchemaArtifact> {
    return this.rowToSchemaArtifact(this.withdrawRaw(documentName, 'schema', name, version, by));
  }

  async getSchemaCurrent(
    documentName: DocumentName,
    name: SchemaName,
  ): Promise<SchemaArtifact | null> {
    const row = this.getRaw(documentName, 'schema', name, { status: 'accepted' });
    return row ? this.rowToSchemaArtifact(row) : null;
  }

  async getSchemaProposed(
    documentName: DocumentName,
    name: SchemaName,
  ): Promise<SchemaArtifact | null> {
    const row = this.getRaw(documentName, 'schema', name, { status: 'proposed' });
    return row ? this.rowToSchemaArtifact(row) : null;
  }

  async getSchemaByVersion(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
  ): Promise<SchemaArtifact | null> {
    const row = this.getRaw(documentName, 'schema', name, { version });
    return row ? this.rowToSchemaArtifact(row) : null;
  }

  async listSchemas(documentName: DocumentName): Promise<SchemaSummary[]> {
    const rows = this.db
      .prepare<[string], ArtifactRow>(
        "SELECT * FROM artifact_versions WHERE document_name = ? AND kind = 'schema' ORDER BY identity_key, version",
      )
      .all(documentName);
    const byKey = new Map<string, ArtifactRow[]>();
    for (const r of rows) {
      const list = byKey.get(r.identity_key);
      if (list) list.push(r);
      else byKey.set(r.identity_key, [r]);
    }
    const out: SchemaSummary[] = [];
    for (const [name, versions] of byKey) {
      out.push({ name, ...this.buildSummary(versions) });
    }
    return out;
  }

  // --- convention artifact (singleton per document) ---

  async proposeConvention(
    documentName: DocumentName,
    spec: ConventionSpec,
    by: Identity,
    opts: ProposeOptions = {},
  ): Promise<ConventionArtifact> {
    return this.rowToConventionArtifact(
      this.proposeRaw(documentName, 'convention', CONVENTION_KEY, spec, by, opts),
    );
  }

  async acceptConvention(
    documentName: DocumentName,
    version: number,
    by: Identity,
    reason?: string,
  ): Promise<ConventionArtifact> {
    return this.rowToConventionArtifact(
      this.acceptRaw(documentName, 'convention', CONVENTION_KEY, version, by, reason),
    );
  }

  async rejectConvention(
    documentName: DocumentName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<ConventionArtifact> {
    return this.rowToConventionArtifact(
      this.rejectRaw(documentName, 'convention', CONVENTION_KEY, version, reason, by),
    );
  }

  async withdrawConvention(
    documentName: DocumentName,
    version: number,
    by: Identity,
  ): Promise<ConventionArtifact> {
    return this.rowToConventionArtifact(
      this.withdrawRaw(documentName, 'convention', CONVENTION_KEY, version, by),
    );
  }

  async getConventionCurrent(documentName: DocumentName): Promise<ConventionArtifact | null> {
    const row = this.getRaw(documentName, 'convention', CONVENTION_KEY, { status: 'accepted' });
    return row ? this.rowToConventionArtifact(row) : null;
  }

  async getConventionProposed(documentName: DocumentName): Promise<ConventionArtifact | null> {
    const row = this.getRaw(documentName, 'convention', CONVENTION_KEY, { status: 'proposed' });
    return row ? this.rowToConventionArtifact(row) : null;
  }

  async getConventionLatest(documentName: DocumentName): Promise<ConventionArtifact | null> {
    const row = this.db
      .prepare<[string, string, string], ArtifactRow>(
        `SELECT * FROM artifact_versions
         WHERE document_name = ? AND kind = ? AND identity_key = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(documentName, 'convention', CONVENTION_KEY);
    return row ? this.rowToConventionArtifact(row) : null;
  }

  async getConventionByVersion(
    documentName: DocumentName,
    version: number,
  ): Promise<ConventionArtifact | null> {
    const row = this.getRaw(documentName, 'convention', CONVENTION_KEY, { version });
    return row ? this.rowToConventionArtifact(row) : null;
  }

  // --- rationale ---

  async rationaleForEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
  ): Promise<RationaleEntry[]> {
    return this.rationaleRaw(documentName, 'operation', operationIdentityKey(method, path));
  }

  async rationaleForSchema(
    documentName: DocumentName,
    name: SchemaName,
  ): Promise<RationaleEntry[]> {
    return this.rationaleRaw(documentName, 'schema', name);
  }

  async rationaleForConvention(documentName: DocumentName): Promise<RationaleEntry[]> {
    return this.rationaleRaw(documentName, 'convention', CONVENTION_KEY);
  }

  private rationaleRaw(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
  ): RationaleEntry[] {
    const rows = this.db
      .prepare<[string, string, string], ArtifactRow>(
        `SELECT * FROM artifact_versions
         WHERE document_name = ? AND kind = ? AND identity_key = ?
         ORDER BY version`,
      )
      .all(documentName, kind, identityKey);
    return this.buildRationale(rows);
  }

  // --- parties / TCP auth ---

  async getIdentityForToken(token: string): Promise<Identity | null> {
    const row = this.db
      .prepare<[string], { identity: string }>(
        'SELECT identity FROM party_tokens WHERE token_hash = ?',
      )
      .get(hashToken(token));
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
    this.db.prepare('DELETE FROM parties WHERE identity = ?').run(identity);
  }

  async touchPartySeen(identity: Identity): Promise<void> {
    this.db.prepare('UPDATE parties SET last_seen_at = ? WHERE identity = ?').run(now(), identity);
  }

  // --- invites ---

  async createInvite(
    identity: Identity,
    ttlSeconds: number,
    grantDocs: DocumentName[] = [],
  ): Promise<Invite> {
    const token = newToken();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const tokenHash = hashToken(token);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO invites (token_hash, identity, created_at, expires_at) VALUES (?, ?, ?, ?)',
        )
        .run(tokenHash, identity, createdAt, expiresAt);
      if (grantDocs.length > 0) {
        const ins = this.db.prepare(
          'INSERT INTO invite_grants (token_hash, document_name) VALUES (?, ?)',
        );
        for (const doc of grantDocs) ins.run(tokenHash, doc);
      }
    });
    tx();
    return { token, identity, createdAt, expiresAt };
  }

  async redeemInvite(inviteToken: string): Promise<{ identity: Identity; token: string }> {
    let issued: { identity: Identity; token: string } | undefined;
    const inviteHash = hashToken(inviteToken);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare<[string], InviteRow>('SELECT * FROM invites WHERE token_hash = ?')
        .get(inviteHash);
      if (!row) throw new StoreError('invite_invalid', 'invite token not recognized');
      if (row.redeemed_at !== null) {
        throw new StoreError('invite_redeemed', 'invite already redeemed');
      }
      // fail-closed on malformed expires_at — pre-fix used `Date.parse() < now()` which
      // returned false for NaN, silently allowing redemption of tampered/corrupt rows.
      if (isExpired(row.expires_at)) {
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
        .prepare('INSERT INTO party_tokens (token_hash, identity, created_at) VALUES (?, ?, ?)')
        .run(hashToken(persistentToken), row.identity, now());
      this.db
        .prepare('UPDATE invites SET redeemed_at = ? WHERE token_hash = ?')
        .run(now(), inviteHash);
      // Apply any doc grants attached to the invite — the new peer becomes a member of
      // each one. Skip silently if a granted doc no longer exists.
      const grants = this.db
        .prepare<[string], { document_name: string }>(
          'SELECT document_name FROM invite_grants WHERE token_hash = ?',
        )
        .all(inviteHash);
      const grantedAt = now();
      const addMember = this.db.prepare(
        `INSERT INTO document_members (document_name, identity, role, granted_by, granted_at)
         VALUES (?, ?, 'member', ?, ?)
         ON CONFLICT(document_name, identity) DO NOTHING`,
      );
      for (const g of grants) {
        const docExists = this.db
          .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM documents WHERE name = ?')
          .get(g.document_name);
        if ((docExists?.c ?? 0) > 0) {
          addMember.run(g.document_name, row.identity, row.identity, grantedAt);
        }
      }
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
    // Excludes self-authored events: an event's author lives in JSON data — `from` for
    // message/artifact_* events, `by` for document_created. SQLite `IS NOT` is null-safe, so an
    // event with neither field (shouldn't happen given EventSchema) passes the filter and is
    // counted as peer activity — the conservative default.
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
                   AND COALESCE(
                     json_extract(e.data, '$.from'),
                     json_extract(e.data, '$.by')
                   ) IS NOT @identity
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
        .prepare<[string, number, string], EventRow>(
          `SELECT * FROM events
             WHERE document_name = ?
               AND id > ?
               AND COALESCE(json_extract(data, '$.from'), json_extract(data, '$.by')) IS NOT ?
             ORDER BY id DESC LIMIT 1`,
        )
        .get(r.document_name, r.last_seen, identity);
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

  async latestVersion(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
  ): Promise<number | null> {
    const row = this.db
      .prepare<[string, string, string], { v: number }>(
        `SELECT MAX(version) AS v FROM artifact_versions
         WHERE document_name = ? AND kind = ? AND identity_key = ?`,
      )
      .get(documentName, kind, identityKey);
    return row?.v ?? null;
  }

  // --- UI sessions (browser auth: OTT → cookie) ---

  async createUiOtt(identity: Identity, ttlSeconds: number): Promise<{ ott: string; expiresAt: string }> {
    const ott = newToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO ui_sessions (token_hash, identity, kind, expires_at)
         VALUES (?, ?, 'ott', ?)`,
      )
      .run(hashToken(ott), identity, expiresAt);
    return { ott, expiresAt };
  }

  async redeemUiOtt(
    ott: string,
  ): Promise<{ identity: Identity; cookieToken: string; cookieExpiresAt: string } | null> {
    const ottHash = hashToken(ott);
    let result: { identity: Identity; cookieToken: string; cookieExpiresAt: string } | null = null;
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare<
          [string],
          { identity: string; kind: string; expires_at: string; consumed_at: string | null }
        >('SELECT identity, kind, expires_at, consumed_at FROM ui_sessions WHERE token_hash = ?')
        .get(ottHash);
      if (!row || row.kind !== 'ott') return;
      if (row.consumed_at !== null) return;
      if (isExpired(row.expires_at)) return;
      const consumedAt = now();
      this.db
        .prepare('UPDATE ui_sessions SET consumed_at = ? WHERE token_hash = ?')
        .run(consumedAt, ottHash);
      const cookieToken = newToken();
      const cookieExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
      this.db
        .prepare(
          `INSERT INTO ui_sessions (token_hash, identity, kind, expires_at)
           VALUES (?, ?, 'cookie', ?)`,
        )
        .run(hashToken(cookieToken), row.identity, cookieExpiresAt);
      result = { identity: row.identity, cookieToken, cookieExpiresAt };
    });
    tx();
    return result;
  }

  async getIdentityForUiSession(cookieToken: string): Promise<Identity | null> {
    const row = this.db
      .prepare<
        [string],
        { identity: string; kind: string; expires_at: string; consumed_at: string | null }
      >('SELECT identity, kind, expires_at, consumed_at FROM ui_sessions WHERE token_hash = ?')
      .get(hashToken(cookieToken));
    if (!row || row.kind !== 'cookie') return null;
    if (isExpired(row.expires_at)) return null;
    return row.identity;
  }

  // --- atomic batch propose ---

  async batchPropose(
    documentName: DocumentName,
    body: BatchProposeInput,
    by: Identity,
  ): Promise<BatchProposeSucceededItem[]> {
    // One outer transaction; each per-artifact propose runs its own inner transaction,
    // which better-sqlite3 implements as a savepoint inside the outer. Any throw out
    // of the outer transaction body rolls back every savepoint plus the outer tx, so
    // partial commit is impossible.
    const succeeded: BatchProposeSucceededItem[] = [];
    const tx = this.db.transaction(() => {
      if (body.convention) {
        const row = this.proposeRaw(
          documentName,
          'convention',
          CONVENTION_KEY,
          body.convention.spec,
          by,
          body.convention.opts ?? {},
        );
        succeeded.push({ kind: 'convention', envelope: this.rowToConventionArtifact(row) });
      }
      if (body.schemas) {
        for (const s of body.schemas) {
          const row = this.proposeRaw(documentName, 'schema', s.name, s.spec, by, s.opts ?? {});
          succeeded.push({
            kind: 'schema',
            name: s.name,
            envelope: this.rowToSchemaArtifact(row),
          });
        }
      }
      if (body.endpoints) {
        for (const e of body.endpoints) {
          const row = this.proposeRaw(
            documentName,
            'operation',
            operationIdentityKey(e.method, e.path),
            e.spec,
            by,
            e.opts ?? {},
          );
          succeeded.push({
            kind: 'endpoint',
            method: e.method,
            path: e.path,
            envelope: this.rowToOperationArtifact(row),
          });
        }
      }
    });
    tx();
    return succeeded;
  }

  // --- lifecycle ---

  async close(): Promise<void> {
    this.db.close();
  }
}

function previewOf(e: Event): string {
  switch (e.kind) {
    case 'message':
      return truncate(neutralizeForReminder(e.text), 80);
    case 'artifact_proposed': {
      const delta = e.delta ? ` (${truncate(neutralizeForReminder(e.delta), 50)})` : '';
      return `proposed ${e.artifactKind} ${e.identityKey} v${e.version}${delta}`;
    }
    case 'artifact_accepted':
      return `accepted ${e.artifactKind} ${e.identityKey} v${e.version}`;
    case 'artifact_rejected':
      return `rejected ${e.artifactKind} ${e.identityKey} v${e.version}: ${truncate(neutralizeForReminder(e.reason), 50)}`;
    case 'artifact_withdrawn':
      return `withdrew ${e.artifactKind} ${e.identityKey} v${e.version}`;
    case 'document_created':
      return `document created by ${e.by}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Inbox previews flow into the UserPromptSubmit hook, which wraps them in a
// <system-reminder> block in Claude's context. Peer-controlled text containing
// </system-reminder> would break out of the wrapper and turn into a forged
// reminder. Replace angle brackets with visually-similar non-tag codepoints
// (U+2039, U+203A) and strip C0 control characters.
export function neutralizeForReminder(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0 controls is the point
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
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

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

import { randomBytes } from 'node:crypto';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { compactSummary, generatePatch } from '../diff.js';
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
} from '../models.js';
import type { EventNotifier } from '../notifier.js';
import type { RationaleEntry, Store } from './index.js';

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
  identity      TEXT NOT NULL,
  document_name TEXT NOT NULL REFERENCES documents(name) ON DELETE CASCADE,
  last_seen     INTEGER NOT NULL,
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
        throw new Error(`accepted artifact ${row.identity_key}@v${row.version} missing accepted_by/at`);
      }
      return {
        ...base,
        status: 'accepted',
        acceptedBy: row.accepted_by,
        acceptedAt: row.accepted_at,
      };
    }
    if (row.rejected_by === null || row.rejected_at === null || row.rejection_reason === null) {
      throw new Error(`rejected artifact ${row.identity_key}@v${row.version} missing rejected_by/at/reason`);
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
      spec: JSON.parse(row.spec) as unknown,
      ...this.statusFieldsFromRow(row),
    });
  }

  private rowToSchemaArtifact(row: ArtifactRow): SchemaArtifact {
    if (row.kind !== 'schema') throw new Error(`expected schema, got ${row.kind}`);
    return SchemaArtifactSchema.parse({
      kind: 'schema',
      documentName: row.document_name,
      name: row.identity_key,
      spec: JSON.parse(row.spec) as unknown,
      ...this.statusFieldsFromRow(row),
    });
  }

  private rowToConventionArtifact(row: ArtifactRow): ConventionArtifact {
    if (row.kind !== 'convention') throw new Error(`expected convention, got ${row.kind}`);
    return ConventionArtifactSchema.parse({
      kind: 'convention',
      documentName: row.document_name,
      spec: JSON.parse(row.spec) as unknown,
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
      const version = (prev?.version ?? 0) + 1;
      const delta =
        prev !== undefined
          ? compactSummary(generatePatch(JSON.parse(prev.spec) as unknown, spec)) || '(no change)'
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
  ): ArtifactRow {
    let row: ArtifactRow | undefined;
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare<[string, string, string, number], ArtifactRow>(
          'SELECT * FROM artifact_versions WHERE document_name = ? AND kind = ? AND identity_key = ? AND version = ?',
        )
        .get(documentName, kind, identityKey, version);
      if (!existing) {
        throw new StoreError(
          'artifact_not_found',
          `${kind} ${identityKey}@v${version} not found`,
        );
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
        throw new StoreError(
          'artifact_not_found',
          `${kind} ${identityKey}@v${version} not found`,
        );
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
        const entry: RationaleEntry = {
          version: r.version,
          status: r.status,
          proposedBy: r.proposed_by,
          proposedAt: r.proposed_at,
          delta: r.delta,
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

  // --- endpoint artifacts ---

  async proposeEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    spec: OperationSpec,
    by: Identity,
  ): Promise<OperationArtifact> {
    const row = this.proposeRaw(
      documentName,
      'operation',
      operationIdentityKey(method, path),
      spec,
      by,
    );
    return this.rowToOperationArtifact(row);
  }

  async acceptEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    by: Identity,
  ): Promise<OperationArtifact> {
    return this.rowToOperationArtifact(
      this.acceptRaw(documentName, 'operation', operationIdentityKey(method, path), version, by),
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
          const spec = JSON.parse(accepted.spec) as { summary?: unknown };
          if (typeof spec.summary === 'string') summary = spec.summary;
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
  ): Promise<SchemaArtifact> {
    return this.rowToSchemaArtifact(this.proposeRaw(documentName, 'schema', name, spec, by));
  }

  async acceptSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    by: Identity,
  ): Promise<SchemaArtifact> {
    return this.rowToSchemaArtifact(this.acceptRaw(documentName, 'schema', name, version, by));
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
  ): Promise<ConventionArtifact> {
    return this.rowToConventionArtifact(
      this.proposeRaw(documentName, 'convention', CONVENTION_KEY, spec, by),
    );
  }

  async acceptConvention(
    documentName: DocumentName,
    version: number,
    by: Identity,
  ): Promise<ConventionArtifact> {
    return this.rowToConventionArtifact(
      this.acceptRaw(documentName, 'convention', CONVENTION_KEY, version, by),
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

  async getConventionCurrent(documentName: DocumentName): Promise<ConventionArtifact | null> {
    const row = this.getRaw(documentName, 'convention', CONVENTION_KEY, { status: 'accepted' });
    return row ? this.rowToConventionArtifact(row) : null;
  }

  async getConventionProposed(documentName: DocumentName): Promise<ConventionArtifact | null> {
    const row = this.getRaw(documentName, 'convention', CONVENTION_KEY, { status: 'proposed' });
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
          'SELECT * FROM events WHERE document_name = ? ORDER BY id DESC LIMIT 1',
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
    case 'artifact_proposed': {
      const delta = e.delta ? ` (${truncate(e.delta, 50)})` : '';
      return `proposed ${e.artifactKind} ${e.identityKey} v${e.version}${delta}`;
    }
    case 'artifact_accepted':
      return `accepted ${e.artifactKind} ${e.identityKey} v${e.version}`;
    case 'artifact_rejected':
      return `rejected ${e.artifactKind} ${e.identityKey} v${e.version}: ${truncate(e.reason, 50)}`;
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

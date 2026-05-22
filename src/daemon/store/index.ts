// Persistence interface. Implementations: SQLite (default, in ./sqlite.ts); future Postgres / Redis
// adapters slot in behind this same surface. All methods are async; sync-internally impls just don't await.
//
// Long-poll WAIT is NOT a method here — it's implemented at the server layer by combining
// `listEvents` (after-the-fact catch-up) with `EventNotifier` (live fan-out). The store's only
// obligation is to call `notifier.notify(documentName)` after a successful append.

import type {
  ConventionArtifact,
  ConventionSpec,
  Cursor,
  Document,
  DocumentName,
  EndpointSummary,
  Event,
  HttpMethod,
  Identity,
  InboxEntry,
  Invite,
  JSONSchema,
  OperationArtifact,
  OperationSpec,
  Party,
  SchemaArtifact,
  SchemaName,
  SchemaSummary,
} from '../../lib/models.js';

/** Opt-in concurrency control on propose. */
export type ProposeOptions = {
  /**
   * `'new'`  → refuse if any prior version of this identity exists.
   * `number` → latest version of this identity must equal this exact value (any status).
   * `undefined` → no version-position assertion.
   */
  expectedVersion?: number | 'new';
  /** Allow proposing while the latest version is still in `proposed` status. Ignored when `expectedVersion` is set. */
  force?: boolean;
};

export type RationaleEntry = {
  version: number;
  status: 'proposed' | 'accepted' | 'rejected';
  proposedBy: Identity;
  proposedAt: string;
  acceptedBy?: Identity;
  acceptedAt?: string;
  rejectedBy?: Identity;
  rejectedAt?: string;
  rejectionReason?: string;
  delta: string | null;
  /** The artifact body for this version. Object shape depends on artifact kind. */
  spec: unknown;
};

export interface Store {
  // --- documents ---
  createDocument(name: DocumentName, by: Identity): Promise<Document>;
  getDocument(name: DocumentName): Promise<Document | null>;
  listDocuments(): Promise<Document[]>;

  // --- events ---
  appendMessage(documentName: DocumentName, from: Identity, text: string): Promise<Event>;
  listEvents(documentName: DocumentName, since: Cursor, limit: number): Promise<Event[]>;
  /** Last N events in chronological order; no cursor needed. */
  listLastEvents(documentName: DocumentName, limit: number): Promise<Event[]>;
  latestCursor(documentName: DocumentName): Promise<Cursor>;

  // --- endpoint artifacts (OpenAPI Operation Objects) ---
  proposeEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    spec: OperationSpec,
    by: Identity,
    opts?: ProposeOptions,
  ): Promise<OperationArtifact>;
  acceptEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    by: Identity,
    reason?: string,
  ): Promise<OperationArtifact>;
  rejectEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<OperationArtifact>;
  withdrawEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
    by: Identity,
  ): Promise<OperationArtifact>;
  getEndpointCurrent(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
  ): Promise<OperationArtifact | null>;
  getEndpointProposed(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
  ): Promise<OperationArtifact | null>;
  getEndpointByVersion(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
    version: number,
  ): Promise<OperationArtifact | null>;
  listEndpoints(documentName: DocumentName): Promise<EndpointSummary[]>;

  // --- schema artifacts (JSON Schema component schemas) ---
  proposeSchema(
    documentName: DocumentName,
    name: SchemaName,
    spec: JSONSchema,
    by: Identity,
    opts?: ProposeOptions,
  ): Promise<SchemaArtifact>;
  acceptSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    by: Identity,
    reason?: string,
  ): Promise<SchemaArtifact>;
  rejectSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<SchemaArtifact>;
  withdrawSchema(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
    by: Identity,
  ): Promise<SchemaArtifact>;
  getSchemaCurrent(documentName: DocumentName, name: SchemaName): Promise<SchemaArtifact | null>;
  getSchemaProposed(documentName: DocumentName, name: SchemaName): Promise<SchemaArtifact | null>;
  getSchemaByVersion(
    documentName: DocumentName,
    name: SchemaName,
    version: number,
  ): Promise<SchemaArtifact | null>;
  listSchemas(documentName: DocumentName): Promise<SchemaSummary[]>;

  // --- convention artifact (singleton per document; info/servers/securitySchemes) ---
  proposeConvention(
    documentName: DocumentName,
    spec: ConventionSpec,
    by: Identity,
    opts?: ProposeOptions,
  ): Promise<ConventionArtifact>;
  acceptConvention(
    documentName: DocumentName,
    version: number,
    by: Identity,
    reason?: string,
  ): Promise<ConventionArtifact>;
  rejectConvention(
    documentName: DocumentName,
    version: number,
    reason: string,
    by: Identity,
  ): Promise<ConventionArtifact>;
  withdrawConvention(
    documentName: DocumentName,
    version: number,
    by: Identity,
  ): Promise<ConventionArtifact>;
  getConventionCurrent(documentName: DocumentName): Promise<ConventionArtifact | null>;
  getConventionProposed(documentName: DocumentName): Promise<ConventionArtifact | null>;
  /** Latest convention row regardless of status — surfaces rejected/withdrawn conventions
   *  that the proposed/current pair would otherwise hide. */
  getConventionLatest(documentName: DocumentName): Promise<ConventionArtifact | null>;
  getConventionByVersion(
    documentName: DocumentName,
    version: number,
  ): Promise<ConventionArtifact | null>;

  // --- rationale (per identity key: full version chain with who/when/why) ---
  rationaleForEndpoint(
    documentName: DocumentName,
    method: HttpMethod,
    path: string,
  ): Promise<RationaleEntry[]>;
  rationaleForSchema(documentName: DocumentName, name: SchemaName): Promise<RationaleEntry[]>;
  rationaleForConvention(documentName: DocumentName): Promise<RationaleEntry[]>;

  // --- parties / TCP auth ---
  getIdentityForToken(token: string): Promise<Identity | null>;
  ensureParty(identity: Identity): Promise<Party>;
  listParties(): Promise<Party[]>;
  revokeParty(identity: Identity): Promise<void>;
  touchPartySeen(identity: Identity): Promise<void>;

  // --- invites ---
  createInvite(
    identity: Identity,
    ttlSeconds: number,
    grantDocs?: DocumentName[],
  ): Promise<Invite>;
  redeemInvite(inviteToken: string): Promise<{ identity: Identity; token: string }>;

  // --- per-document ACL (TCP-only enforcement; socket transport bypasses) ---
  isMember(documentName: DocumentName, identity: Identity): Promise<boolean>;
  listDocumentsForMember(identity: Identity): Promise<Document[]>;
  addDocumentMember(
    documentName: DocumentName,
    identity: Identity,
    role: 'owner' | 'member',
    grantedBy: Identity,
  ): Promise<void>;
  removeDocumentMember(documentName: DocumentName, identity: Identity): Promise<void>;
  listDocumentMembers(documentName: DocumentName): Promise<
    Array<{ identity: Identity; role: 'owner' | 'member'; grantedBy: Identity; grantedAt: string }>
  >;

  // --- cursors (server-tracked per (identity, document)) ---
  getLastSeenCursor(identity: Identity, documentName: DocumentName): Promise<Cursor>;
  advanceCursor(identity: Identity, documentName: DocumentName, cursor: Cursor): Promise<void>;

  // --- inbox (cross-document summary for one identity) ---
  inboxSummary(identity: Identity): Promise<InboxEntry[]>;

  // --- diff support ---
  /** Return the highest existing version number for an artifact regardless of status,
   *  or null if none. Used by the diff endpoint to default `--to` to the actual latest
   *  without linearly probing version numbers. */
  latestVersion(
    documentName: DocumentName,
    kind: 'operation' | 'schema' | 'convention',
    identityKey: string,
  ): Promise<number | null>;

  // --- atomic batch propose ---
  /**
   * Atomically propose a coordinated set of artifacts. Runs all per-artifact proposes
   * inside one transaction — any failure rolls back the whole batch, so partial
   * state is impossible. The caller is responsible for validating the assembled doc
   * before invoking this; per-artifact errors here (e.g. version_in_flight from a
   * racing peer) abort and roll back.
   */
  batchPropose(
    documentName: DocumentName,
    body: BatchProposeInput,
    by: Identity,
  ): Promise<BatchProposeSucceededItem[]>;

  // --- lifecycle ---
  close(): Promise<void>;
}

export type BatchProposeInput = {
  convention?: { spec: ConventionSpec; opts?: ProposeOptions };
  schemas?: Array<{ name: SchemaName; spec: JSONSchema; opts?: ProposeOptions }>;
  endpoints?: Array<{
    method: HttpMethod;
    path: string;
    spec: OperationSpec;
    opts?: ProposeOptions;
  }>;
};

export type BatchProposeSucceededItem =
  | { kind: 'convention'; envelope: ConventionArtifact }
  | { kind: 'schema'; name: SchemaName; envelope: SchemaArtifact }
  | { kind: 'endpoint'; method: HttpMethod; path: string; envelope: OperationArtifact };

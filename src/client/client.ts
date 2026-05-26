// Typed HTTP client for the brackish wire protocol. One transport-aware request function
// underneath; typed methods on top.
//
// Socket mode: undici Agent with a unix-socket connect option; sends X-Brackish-Identity.
// TCP mode:    plain fetch; sends Authorization: Bearer <token>.

import { TLSSocket } from 'node:tls';
import {
  Agent,
  buildConnector,
  type Response as UndiciResponse,
  fetch as undiciFetch,
} from 'undici';
import { z } from 'zod';
import {
  type AcceptBatchRequest,
  AcceptBatchResponseSchema,
  type ConnectResponse,
  ConnectResponseSchema,
  type ConventionArtifact,
  ConventionArtifactSchema,
  type ConventionSpec,
  type CounterRequest,
  CounterResponseSchema,
  type DeliverResponse,
  DeliverResponseSchema,
  type DiffResponse,
  DiffResponseSchema,
  type Document,
  type DocumentMember,
  DocumentMemberSchema,
  type DocumentName,
  DocumentSchema,
  type EndpointListResponse,
  EndpointListResponseSchema,
  type EventListResponse,
  EventListResponseSchema,
  type HeldResponse,
  HeldResponseSchema,
  type HttpMethod,
  type Identity,
  type InboxResponse,
  InboxResponseSchema,
  type InviteCreatedResponse,
  InviteCreatedResponseSchema,
  type JSONSchema,
  type OperationArtifact,
  OperationArtifactSchema,
  type OperationSpec,
  operationIdentityKey,
  type PartiesResponse,
  PartiesResponseSchema,
  type ProposeBatchRequest,
  type ProposeBatchResponse,
  ProposeBatchResponseSchema,
  type RationaleResponse,
  RationaleResponseSchema,
  type RetractionListResponse,
  RetractionListResponseSchema,
  type RetractionResponse,
  RetractionResponseSchema,
  type RetractRequest,
  type SchemaArtifact,
  SchemaArtifactSchema,
  type SchemaListResponse,
  SchemaListResponseSchema,
  type SchemaName,
  SendMessageResponseSchema,
  type ValidateRequest,
  type ValidateResponse,
  ValidateResponseSchema,
  type WhoamiResponse,
  WhoamiResponseSchema,
} from '../lib/models.js';
import { type OpenAPIDocument, OpenAPIDocumentSchema } from '../lib/openapi.js';
import { normalizePin } from '../lib/tls.js';

export type SpecIssue = { severity: 'error' | 'warn'; field: string; message: string };

/** One-line label for an auto-included (--include-dependencies) artifact, for CLI reporting. */
function acceptedItemLabel(
  item: { kind: 'schema'; name: string } | { kind: 'endpoint'; method: string; path: string },
): string {
  return item.kind === 'schema'
    ? `schema ${item.name}`
    : `endpoint ${item.method.toUpperCase()} ${item.path}`;
}

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly issues: SpecIssue[] = [],
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

type RequestFn = (
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> },
) => Promise<UndiciResponse>;

/** Discriminated union: socket-trust mode needs an identity; TCP mode needs a server+token.
 *  `tlsPin` is required when `server` is https:// (we pin the self-signed cert by fingerprint). */
export type BrackishClientOptions =
  | { socketPath: string; identity: Identity }
  | { server: string; token: string; tlsPin?: string };

export class BrackishClient {
  private readonly request: RequestFn;
  private readonly cleanup: (() => Promise<void>) | null;

  constructor(opts: BrackishClientOptions) {
    if ('socketPath' in opts) {
      const dispatcher = new Agent({ connect: { socketPath: opts.socketPath } });
      const identity = opts.identity;
      this.request = (path, init) =>
        undiciFetch(buildUrl('http://localhost', path, init?.query), {
          method: init?.method ?? 'GET',
          headers: jsonHeaders({ 'X-Brackish-Identity': identity }, init?.body),
          dispatcher,
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      this.cleanup = () => dispatcher.close();
    } else {
      const base = opts.server.replace(/\/$/, '');
      const token = opts.token;
      const dispatcher = tlsDispatcher(base, opts.tlsPin);
      this.request = (path, init) =>
        undiciFetch(buildUrl(base, path, init?.query), {
          method: init?.method ?? 'GET',
          headers: jsonHeaders({ Authorization: `Bearer ${token}` }, init?.body),
          ...(dispatcher ? { dispatcher } : {}),
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      this.cleanup = dispatcher ? () => dispatcher.close() : null;
    }
  }

  async close(): Promise<void> {
    if (this.cleanup) await this.cleanup();
  }

  // --- public + identity ---

  async healthz(): Promise<{ ok: boolean; version: string }> {
    return this.fetchAndParse('/healthz', HealthzResponseSchema);
  }

  whoami(): Promise<WhoamiResponse> {
    return this.fetchAndParse('/whoami', WhoamiResponseSchema);
  }

  // --- documents ---

  listDocuments(): Promise<Document[]> {
    return this.fetchAndParseField('/documents', 'documents', DocumentSchema.array());
  }

  createDocument(name: DocumentName): Promise<Document> {
    return this.fetchAndParse('/documents', DocumentSchema, { method: 'POST', body: { name } });
  }

  getDocument(name: DocumentName): Promise<Document> {
    return this.fetchAndParse(`/documents/${encodeURIComponent(name)}`, DocumentSchema);
  }

  // --- messages, events, wait, inbox ---

  async sendMessage(
    document: DocumentName,
    text: string,
  ): Promise<EventListResponse['events'][number]> {
    const parsed = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/messages`,
      SendMessageResponseSchema,
      { method: 'POST', body: { text } },
    );
    return parsed.event;
  }

  listEvents(
    document: DocumentName,
    opts: { since?: number; limit?: number; tail?: number } = {},
  ): Promise<EventListResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/events`,
      EventListResponseSchema,
      { query: { since: opts.since, limit: opts.limit, tail: opts.tail } },
    );
  }

  wait(
    document: DocumentName,
    opts: { since?: number; timeoutSeconds?: number } = {},
  ): Promise<EventListResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/wait`,
      EventListResponseSchema,
      { query: { since: opts.since, timeout: opts.timeoutSeconds } },
    );
  }

  inbox(): Promise<InboxResponse> {
    return this.fetchAndParse('/inbox', InboxResponseSchema);
  }

  // --- propose-batch (atomic multi-artifact propose) ---

  proposeBatch(document: DocumentName, body: ProposeBatchRequest): Promise<ProposeBatchResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/propose-batch`,
      ProposeBatchResponseSchema,
      { method: 'POST', body },
    );
  }

  /** Atomically accept a set of proposed schemas. All-or-nothing: on any failure nothing is
   *  accepted (the call rejects). Returns the accepted versions on success. */
  async batchAcceptSchemas(
    document: DocumentName,
    names: SchemaName[],
    rationale?: string,
    includeDependencies?: boolean,
  ): Promise<{ accepted: SchemaArtifact[]; dependencies: string[] }> {
    const body: AcceptBatchRequest = { schemas: names };
    if (rationale !== undefined) body.rationale = rationale;
    if (includeDependencies === true) body.includeDependencies = true;
    const res = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/accept-batch`,
      AcceptBatchResponseSchema,
      { method: 'POST', body },
    );
    const accepted: SchemaArtifact[] = [];
    for (const item of res.accepted) if (item.kind === 'schema') accepted.push(item.envelope);
    return { accepted, dependencies: res.dependencies.map(acceptedItemLabel) };
  }

  /** Atomically accept a set of proposed endpoints. All-or-nothing (see batchAcceptSchemas). */
  async batchAcceptEndpoints(
    document: DocumentName,
    targets: Array<{ method: HttpMethod; path: string }>,
    rationale?: string,
    includeDependencies?: boolean,
  ): Promise<{ accepted: OperationArtifact[]; dependencies: string[] }> {
    const body: AcceptBatchRequest = { endpoints: targets };
    if (rationale !== undefined) body.rationale = rationale;
    if (includeDependencies === true) body.includeDependencies = true;
    const res = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/accept-batch`,
      AcceptBatchResponseSchema,
      { method: 'POST', body },
    );
    const accepted: OperationArtifact[] = [];
    for (const item of res.accepted) if (item.kind === 'endpoint') accepted.push(item.envelope);
    return { accepted, dependencies: res.dependencies.map(acceptedItemLabel) };
  }

  /** Counter a proposed endpoint: reject the current proposed version + propose `spec`, atomically. */
  async counterEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    spec: OperationSpec,
    reason: string,
    concurrency: ProposeOptionsWire = {},
  ): Promise<OperationArtifact> {
    const body: CounterRequest = { kind: 'endpoint', method, path, spec, reason };
    if (concurrency.expectedVersion !== undefined || concurrency.force !== undefined) {
      body.options = concurrency;
    }
    const res = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/counter`,
      CounterResponseSchema,
      { method: 'POST', body },
    );
    if (res.kind !== 'endpoint') throw new Error('counter: unexpected response kind');
    return res.envelope;
  }

  /** Counter a proposed schema (see counterEndpoint). */
  async counterSchema(
    document: DocumentName,
    name: SchemaName,
    spec: JSONSchema,
    reason: string,
    concurrency: ProposeOptionsWire = {},
  ): Promise<SchemaArtifact> {
    const body: CounterRequest = { kind: 'schema', name, spec, reason };
    if (concurrency.expectedVersion !== undefined || concurrency.force !== undefined) {
      body.options = concurrency;
    }
    const res = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/counter`,
      CounterResponseSchema,
      { method: 'POST', body },
    );
    if (res.kind !== 'schema') throw new Error('counter: unexpected response kind');
    return res.envelope;
  }

  /** Counter the proposed convention (see counterEndpoint). */
  async counterConvention(
    document: DocumentName,
    spec: ConventionSpec,
    reason: string,
    concurrency: ProposeOptionsWire = {},
  ): Promise<ConventionArtifact> {
    const body: CounterRequest = { kind: 'convention', spec, reason };
    if (concurrency.expectedVersion !== undefined || concurrency.force !== undefined) {
      body.options = concurrency;
    }
    const res = await this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/counter`,
      CounterResponseSchema,
      { method: 'POST', body },
    );
    if (res.kind !== 'convention') throw new Error('counter: unexpected response kind');
    return res.envelope;
  }

  /** Deliver the caller's held events — make this turn's moves visible to the peer. */
  deliver(document: DocumentName): Promise<DeliverResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/deliver`,
      DeliverResponseSchema,
      { method: 'POST' },
    );
  }

  /** Read-only: the caller's held (undelivered) moves, grouped by doc. */
  heldByDoc(): Promise<HeldResponse['held']> {
    return this.fetchAndParse('/held', HeldResponseSchema).then((r) => r.held);
  }

  /** Dry-run: assemble + meta-schema-validate the doc (optionally with an overlay), writing
   *  nothing. Empty body validates the current accepted doc. */
  validate(document: DocumentName, body: ValidateRequest = {}): Promise<ValidateResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/validate`,
      ValidateResponseSchema,
      { method: 'POST', body },
    );
  }

  /** Propose a grouped retraction (negotiated removal). The peer accepts/rejects it. */
  proposeRetraction(document: DocumentName, body: RetractRequest): Promise<RetractionResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/retractions`,
      RetractionResponseSchema,
      { method: 'POST', body },
    );
  }

  listRetractions(
    document: DocumentName,
    opts: { status?: 'proposed' | 'accepted' | 'rejected' | 'withdrawn' } = {},
  ): Promise<RetractionListResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/retractions`,
      RetractionListResponseSchema,
      { query: { status: opts.status } },
    );
  }

  acceptRetraction(document: DocumentName, id: number): Promise<RetractionResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/retractions/${id}/accept`,
      RetractionResponseSchema,
      { method: 'POST' },
    );
  }

  rejectRetraction(
    document: DocumentName,
    id: number,
    reason: string,
  ): Promise<RetractionResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/retractions/${id}/reject`,
      RetractionResponseSchema,
      { method: 'POST', body: { reason } },
    );
  }

  withdrawRetraction(document: DocumentName, id: number): Promise<RetractionResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/retractions/${id}/withdraw`,
      RetractionResponseSchema,
      { method: 'POST' },
    );
  }

  // --- endpoints (operation artifacts) ---

  proposeEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    spec: OperationSpec,
    opts: ProposeOptionsWire = {},
  ): Promise<OperationArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/endpoints`,
      OperationArtifactSchema,
      { method: 'POST', body: { method, path, spec }, query: proposeOptionsToQuery(opts) },
    );
  }

  listEndpoints(document: DocumentName): Promise<EndpointListResponse['endpoints']> {
    return this.fetchAndParse<EndpointListResponse>(
      `/documents/${encodeURIComponent(document)}/endpoints`,
      EndpointListResponseSchema,
    ).then((r) => r.endpoints);
  }

  getEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    opts: { version?: number; proposed?: boolean } = {},
  ): Promise<OperationArtifact> {
    const id = encodeURIComponent(operationIdentityKey(method, path));
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/endpoints/${id}`,
      OperationArtifactSchema,
      { query: { version: opts.version, proposed: opts.proposed ? '1' : undefined } },
    );
  }

  acceptEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    version?: number,
    reason?: string,
  ): Promise<OperationArtifact> {
    const id = encodeURIComponent(operationIdentityKey(method, path));
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/endpoints/${id}/accept`,
      OperationArtifactSchema,
      {
        method: 'POST',
        query: { version },
        ...(reason !== undefined ? { body: { reason } } : {}),
      },
    );
  }

  rejectEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    reason: string,
    version?: number,
  ): Promise<OperationArtifact> {
    const id = encodeURIComponent(operationIdentityKey(method, path));
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/endpoints/${id}/reject`,
      OperationArtifactSchema,
      { method: 'POST', body: { reason }, query: { version } },
    );
  }

  withdrawEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    version?: number,
  ): Promise<OperationArtifact> {
    const id = encodeURIComponent(operationIdentityKey(method, path));
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/endpoints/${id}/withdraw`,
      OperationArtifactSchema,
      { method: 'POST', query: { version } },
    );
  }

  diffEndpoint(
    document: DocumentName,
    method: HttpMethod,
    path: string,
    opts: { from?: number; to?: number } = {},
  ): Promise<DiffResponse> {
    const id = encodeURIComponent(operationIdentityKey(method, path));
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/endpoints/${id}/diff`,
      DiffResponseSchema,
      { query: { from: opts.from, to: opts.to } },
    );
  }

  // --- schemas (JSON Schema component artifacts) ---

  proposeSchema(
    document: DocumentName,
    name: SchemaName,
    spec: JSONSchema,
    opts: ProposeOptionsWire = {},
  ): Promise<SchemaArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/schemas`,
      SchemaArtifactSchema,
      { method: 'POST', body: { name, spec }, query: proposeOptionsToQuery(opts) },
    );
  }

  listSchemas(document: DocumentName): Promise<SchemaListResponse['schemas']> {
    return this.fetchAndParse<SchemaListResponse>(
      `/documents/${encodeURIComponent(document)}/schemas`,
      SchemaListResponseSchema,
    ).then((r) => r.schemas);
  }

  getSchema(
    document: DocumentName,
    name: SchemaName,
    opts: { version?: number; proposed?: boolean } = {},
  ): Promise<SchemaArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/schemas/${encodeURIComponent(name)}`,
      SchemaArtifactSchema,
      { query: { version: opts.version, proposed: opts.proposed ? '1' : undefined } },
    );
  }

  acceptSchema(
    document: DocumentName,
    name: SchemaName,
    version?: number,
    reason?: string,
  ): Promise<SchemaArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/schemas/${encodeURIComponent(name)}/accept`,
      SchemaArtifactSchema,
      {
        method: 'POST',
        query: { version },
        ...(reason !== undefined ? { body: { reason } } : {}),
      },
    );
  }

  rejectSchema(
    document: DocumentName,
    name: SchemaName,
    reason: string,
    version?: number,
  ): Promise<SchemaArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/schemas/${encodeURIComponent(name)}/reject`,
      SchemaArtifactSchema,
      { method: 'POST', body: { reason }, query: { version } },
    );
  }

  withdrawSchema(
    document: DocumentName,
    name: SchemaName,
    version?: number,
  ): Promise<SchemaArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/schemas/${encodeURIComponent(name)}/withdraw`,
      SchemaArtifactSchema,
      { method: 'POST', query: { version } },
    );
  }

  diffSchema(
    document: DocumentName,
    name: SchemaName,
    opts: { from?: number; to?: number } = {},
  ): Promise<DiffResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/schemas/${encodeURIComponent(name)}/diff`,
      DiffResponseSchema,
      { query: { from: opts.from, to: opts.to } },
    );
  }

  // --- convention (singleton per document) ---

  proposeConvention(
    document: DocumentName,
    spec: ConventionSpec,
    opts: ProposeOptionsWire = {},
  ): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention`,
      ConventionArtifactSchema,
      { method: 'POST', body: { spec }, query: proposeOptionsToQuery(opts) },
    );
  }

  getConventionCurrent(document: DocumentName): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention`,
      ConventionArtifactSchema,
    );
  }

  getConventionProposed(document: DocumentName): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention/proposed`,
      ConventionArtifactSchema,
    );
  }

  getConventionLatest(document: DocumentName): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention/latest`,
      ConventionArtifactSchema,
    );
  }

  getConventionByVersion(document: DocumentName, version: number): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention`,
      ConventionArtifactSchema,
      { query: { version } },
    );
  }

  acceptConvention(
    document: DocumentName,
    version?: number,
    reason?: string,
  ): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention/accept`,
      ConventionArtifactSchema,
      {
        method: 'POST',
        query: { version },
        ...(reason !== undefined ? { body: { reason } } : {}),
      },
    );
  }

  rejectConvention(
    document: DocumentName,
    reason: string,
    version?: number,
  ): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention/reject`,
      ConventionArtifactSchema,
      { method: 'POST', body: { reason }, query: { version } },
    );
  }

  withdrawConvention(document: DocumentName, version?: number): Promise<ConventionArtifact> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention/withdraw`,
      ConventionArtifactSchema,
      { method: 'POST', query: { version } },
    );
  }

  diffConvention(
    document: DocumentName,
    opts: { from?: number; to?: number } = {},
  ): Promise<DiffResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/convention/diff`,
      DiffResponseSchema,
      { query: { from: opts.from, to: opts.to } },
    );
  }

  // --- render helpers ---

  async getOpenApiYaml(document: DocumentName): Promise<string> {
    const res = await this.request(`/documents/${encodeURIComponent(document)}/openapi.yaml`);
    if (!res.ok) {
      const body = ErrorBodySchema.parse(await res.json());
      throw new ClientError(
        res.status,
        body.code ?? null,
        body.error ?? `HTTP ${res.status}`,
        body.issues ?? [],
      );
    }
    return res.text();
  }

  getOpenApiJson(document: DocumentName): Promise<OpenAPIDocument> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/openapi.json`,
      OpenAPIDocumentSchema,
    );
  }

  getRationaleJson(document: DocumentName): Promise<RationaleResponse> {
    return this.fetchAndParse(
      `/documents/${encodeURIComponent(document)}/rationale.json`,
      RationaleResponseSchema,
    );
  }

  // --- parties, invites, connect ---

  createInvite(
    identity: Identity,
    ttlSeconds: number,
    grantDocs: DocumentName[] = [],
  ): Promise<InviteCreatedResponse> {
    const body: { identity: Identity; ttlSeconds: number; grantDocs?: DocumentName[] } = {
      identity,
      ttlSeconds,
    };
    if (grantDocs.length > 0) body.grantDocs = grantDocs;
    return this.fetchAndParse('/invites', InviteCreatedResponseSchema, {
      method: 'POST',
      body,
    });
  }

  // --- per-document ACL ---

  listMembers(document: DocumentName): Promise<DocumentMember[]> {
    return this.fetchAndParseField(
      `/documents/${encodeURIComponent(document)}/members`,
      'members',
      DocumentMemberSchema.array(),
    );
  }

  async addMember(
    document: DocumentName,
    identity: Identity,
    role: 'owner' | 'member',
  ): Promise<void> {
    const res = await this.request(`/documents/${encodeURIComponent(document)}/members`, {
      method: 'POST',
      body: { identity, role },
    });
    await okJson(res);
  }

  async removeMember(document: DocumentName, identity: Identity): Promise<void> {
    const res = await this.request(
      `/documents/${encodeURIComponent(document)}/members/${encodeURIComponent(identity)}`,
      { method: 'DELETE' },
    );
    await okJson(res);
  }

  /** /connect doesn't require auth, but it's still exposed here for convenience when the caller
   *  is already authenticated. The standalone `redeemInvite(server, inviteToken)` helper is
   *  what bootstrap code uses, because at that point you don't yet have a persistent token. */
  connect(inviteToken: string): Promise<ConnectResponse> {
    return this.fetchAndParse('/connect', ConnectResponseSchema, {
      method: 'POST',
      body: { inviteToken },
    });
  }

  listParties(): Promise<PartiesResponse> {
    return this.fetchAndParse('/parties', PartiesResponseSchema);
  }

  async revokeParty(identity: Identity): Promise<void> {
    const res = await this.request(`/parties/${encodeURIComponent(identity)}`, {
      method: 'DELETE',
    });
    await okJson(res);
  }

  // --- internals ---

  private async fetchAndParse<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: Parameters<RequestFn>[1],
  ): Promise<T> {
    const res = await this.request(path, init);
    const body = await okJson(res);
    return schema.parse(body);
  }

  private async fetchAndParseField<T>(
    path: string,
    field: string,
    schema: z.ZodType<T>,
    init?: Parameters<RequestFn>[1],
  ): Promise<T> {
    const res = await this.request(path, init);
    const envelope = z.record(z.string(), z.unknown()).parse(await okJson(res));
    return schema.parse(envelope[field]);
  }
}

const HealthzResponseSchema = z.object({ ok: z.boolean(), version: z.string() });

// --- TLS pinning ---
//
// For https:// servers we don't trust a CA chain — we pin the server's self-signed cert by
// SHA-256 fingerprint (the pin rides in the connect line). The undici connector does the TLS
// handshake with chain validation off, then accepts the socket ONLY if the presented cert's
// fingerprint matches the pin. So an attacker can't substitute their own cert, and connecting
// by raw IP works (no hostname/SAN matching needed). http:// uses no dispatcher, as before.

/** Build the undici dispatcher for a TCP server URL. Returns null for http:// (default agent).
 *  Throws if https:// has no pin (pinning is mandatory) or a pin is given for http://. */
function tlsDispatcher(server: string, tlsPin: string | undefined): Agent | null {
  if (!server.startsWith('https://')) {
    if (tlsPin !== undefined) {
      throw new Error(`--tls-pin given but server URL "${server}" is not https://`);
    }
    return null;
  }
  if (tlsPin === undefined) {
    throw new Error(
      `https:// server "${server}" requires a --tls-pin (the cert fingerprint from the invite line); ` +
        'brackish pins the self-signed cert rather than trusting a CA',
    );
  }
  const pin = normalizePin(tlsPin);
  // Disable TLS session resumption (`maxCachedSessions: 0`). With resumption ON (undici's default
  // caches ~100 sessions), only the FIRST connection per process does a full handshake that
  // presents the cert; every later connection resumes with an abbreviated handshake, no cert is
  // re-sent, and we'd be forced to skip the pin check — trusting that undici's session cache only
  // ever holds pin-verified sessions. It doesn't reliably: a rejected MITM connection's session
  // ticket can be cached before our destroy() (esp. TLS 1.2, where it arrives mid-handshake), so a
  // later resume would bypass the pin. Off, every connection presents its cert and is pin-checked.
  // No shade to undici, I just don't know enough about it to trust it and this costs very little.
  const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  const connector: typeof base = (connOpts, cb) => {
    base(connOpts, (err, socket) => {
      if (err !== null || socket === null) {
        cb(err ?? new Error('TLS connect failed'), null);
        return;
      }
      if (!(socket instanceof TLSSocket)) {
        socket.destroy();
        cb(new Error('expected a TLS connection for https://'), null);
        return;
      }
      // Fail closed: if a session is ever reused despite caching being off, no cert is presented,
      // so we cannot verify the pin — refuse rather than trust an unverified peer.
      if (socket.isSessionReused()) {
        socket.destroy();
        cb(new Error('TLS session unexpectedly resumed; cannot verify cert pin — refusing'), null);
        return;
      }
      const fp = socket.getPeerCertificate().fingerprint256;
      if (typeof fp !== 'string') {
        socket.destroy();
        cb(new Error('TLS: server presented no certificate to pin'), null);
        return;
      }
      const presented = normalizePin(fp);
      if (presented !== pin) {
        socket.destroy();
        cb(
          new Error(
            `TLS cert pin mismatch: server presented ${presented}, expected ${pin} — ` +
              'the cert changed or the connection is being intercepted',
          ),
          null,
        );
        return;
      }
      cb(null, socket);
    });
  };
  return new Agent({ connect: connector });
}

// --- helpers ---

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return `${base}${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

function jsonHeaders(extra: Record<string, string>, body: unknown): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return h;
}

const SpecIssueSchema = z.object({
  severity: z.enum(['error', 'warn']),
  field: z.string(),
  message: z.string(),
});

const ErrorBodySchema = z
  .object({
    error: z.string().optional(),
    code: z.string().optional(),
    issues: z.array(SpecIssueSchema).optional(),
  })
  .passthrough();

async function okJson(res: UndiciResponse): Promise<unknown> {
  const body: unknown = await res.json();
  if (!res.ok) {
    const e = ErrorBodySchema.parse(body);
    throw new ClientError(
      res.status,
      e.code ?? null,
      e.error ?? `HTTP ${res.status}`,
      e.issues ?? [],
    );
  }
  return body;
}

/** Standalone bootstrap helper: trade an invite token for a persistent (identity, token) pair.
 *  Doesn't require an authenticated client because /connect is a public route. The pin (when the
 *  server is https://) protects this very first, token-bearing request — there's no unverified
 *  window. */
export async function redeemInvite(
  server: string,
  inviteToken: string,
  opts: { tlsPin?: string } = {},
): Promise<ConnectResponse> {
  const url = `${server.replace(/\/$/, '')}/connect`;
  const dispatcher = tlsDispatcher(server, opts.tlsPin);
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteToken }),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const body = await okJson(res);
    return ConnectResponseSchema.parse(body);
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}

/** Optional concurrency hints on `proposeEndpoint` / `proposeSchema` / `proposeConvention`. */
export type ProposeOptionsWire = {
  expectedVersion?: number | 'new';
  force?: boolean;
};

function proposeOptionsToQuery(opts: ProposeOptionsWire): Record<string, string | undefined> {
  const q: Record<string, string | undefined> = {};
  if (opts.expectedVersion === 'new') q.expected_version = 'new';
  else if (typeof opts.expectedVersion === 'number')
    q.expected_version = String(opts.expectedVersion);
  if (opts.force) q.force = 'true';
  return q;
}

/** Adapter from ClientConfig (CLI-facing) to BrackishClientOptions (transport-discriminated). */
export function clientOptionsFromConfig(
  cfg: import('../io/config.js').ClientConfig,
): BrackishClientOptions {
  if (cfg.socketPath !== undefined) {
    return { socketPath: cfg.socketPath, identity: cfg.identity };
  }
  if (cfg.server !== undefined && cfg.token !== undefined) {
    return {
      server: cfg.server,
      token: cfg.token,
      ...(cfg.tlsPin !== undefined ? { tlsPin: cfg.tlsPin } : {}),
    };
  }
  throw new Error(
    'client config has neither a socketPath nor a server+token pair; run `brackish init` first',
  );
}

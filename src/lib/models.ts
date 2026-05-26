// Wire-protocol + domain schemas. Single source of truth for shapes and runtime validation.
// Pattern: <Name>Schema is the zod value; <Name> is the inferred type. Import both as needed.
//
// v0.2 model: artifacts are kind-discriminated (operation/schema/convention), each carrying a
// typed `spec` that's a subset of the corresponding OpenAPI 3.1 object (with passthrough so
// unknown fields and x-brackish extension round-trip cleanly). No more freeform `kind: string`
// + opaque `content: string`.

import { z } from 'zod';

// --- scalars ---

const nameRegex = /^[a-z][a-z0-9_-]{0,63}$/;
const schemaNameRegex = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const IdentitySchema = z
  .string()
  .regex(nameRegex, 'identity must match /^[a-z][a-z0-9_-]{0,63}$/');
export const DocumentNameSchema = z
  .string()
  .regex(nameRegex, 'document name must match /^[a-z][a-z0-9_-]{0,63}$/');
export const SchemaNameSchema = z
  .string()
  .regex(schemaNameRegex, 'schema name must match /^[A-Za-z][A-Za-z0-9_]{0,63}$/');
const CursorSchema = z.number().int().nonnegative();
export const TokenSchema = z.string().min(16).max(256);

export const HttpMethodSchema = z.enum([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
]);

export const PathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9._~\-/{}]*$/, 'path must start with / and contain only URL-safe chars');

const ArtifactKindSchema = z.enum(['operation', 'schema', 'convention']);

export type Identity = z.infer<typeof IdentitySchema>;
export type DocumentName = z.infer<typeof DocumentNameSchema>;
export type SchemaName = z.infer<typeof SchemaNameSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

// --- document ---

export const DocumentSchema = z.object({
  name: DocumentNameSchema,
  createdBy: IdentitySchema,
  createdAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

// --- party (TCP auth subject) ---

const PartySchema = z.object({
  identity: IdentitySchema,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
});
export type Party = z.infer<typeof PartySchema>;

// --- invite ---

const InviteSchema = z.object({
  token: TokenSchema,
  identity: IdentitySchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Invite = z.infer<typeof InviteSchema>;

// --- OpenAPI specs (subset validation; passthrough preserves anything we don't enumerate) ---

// JSON Schema (OpenAPI 3.1 dialect). We don't try to fully validate; runtime accepts any object,
// type-side gives `Record<string, unknown>`. Downstream tools (Swagger UI, codegen) catch deeper
// errors. We trust Claude to write reasonable JSON Schema.
export const JSONSchemaSchema = z.object({}).passthrough();
export type JSONSchema = z.infer<typeof JSONSchemaSchema>;

// OpenAPI MediaType: { schema?, example?, examples? }
const MediaTypeSchema = z
  .object({
    schema: JSONSchemaSchema.optional(),
    example: z.unknown().optional(),
    examples: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// OpenAPI RequestBody object
const RequestBodySchema = z
  .object({
    description: z.string().optional(),
    required: z.boolean().optional(),
    content: z.record(z.string(), MediaTypeSchema),
  })
  .passthrough();

// OpenAPI Response object (per status code)
const ResponseSchema = z
  .object({
    description: z.string(),
    content: z.record(z.string(), MediaTypeSchema).optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// OpenAPI Parameter object (path/query/header/cookie)
const ParameterSchema = z
  .object({
    name: z.string(),
    in: z.enum(['path', 'query', 'header', 'cookie']),
    description: z.string().optional(),
    required: z.boolean().optional(),
    schema: JSONSchemaSchema.optional(),
  })
  .passthrough();

// OpenAPI Operation Object. responses is required by spec; everything else is optional.
// .passthrough() is load-bearing here — it preserves x-brackish extension and any OpenAPI
// fields we haven't enumerated (like callbacks, externalDocs, etc.).
export const OperationSpecSchema = z
  .object({
    summary: z.string().optional(),
    description: z.string().optional(),
    operationId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    parameters: z.array(ParameterSchema).optional(),
    requestBody: RequestBodySchema.optional(),
    responses: z.record(z.string(), ResponseSchema),
    security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
    deprecated: z.boolean().optional(),
  })
  .passthrough();
export type OperationSpec = z.infer<typeof OperationSpecSchema>;

// OpenAPI Convention = info + servers + components.securitySchemes (document-level metadata).
const InfoSchema = z
  .object({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const ServerSchema = z
  .object({
    url: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

const SecuritySchemeSchema = z
  .object({
    type: z.enum(['apiKey', 'http', 'oauth2', 'openIdConnect', 'mutualTLS']),
  })
  .passthrough();

export const ConventionSpecSchema = z
  .object({
    info: InfoSchema,
    servers: z.array(ServerSchema).optional(),
    securitySchemes: z.record(z.string(), SecuritySchemeSchema).optional(),
    // Document-level OpenAPI `security` requirement list. Lives in passthrough territory in the
    // OpenAPI spec but we model it here so it round-trips through the type system.
    security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
    // brackish-private extension namespace; not part of OpenAPI. `naming` ∈ {camelCase, snake_case}
    // is the only field we read today; others round-trip through passthrough.
    'x-brackish': z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ConventionSpec = z.infer<typeof ConventionSpecSchema>;

// --- artifact-version envelopes (per kind, status-discriminated) ---
//
// Identity scheme:
//   operation:  identityKey = `<METHOD> <path>` (e.g. `POST /users/{id}`)
//   schema:     identityKey = `<NAME>` (e.g. `User`)
//   convention: identityKey = the literal `"convention"` (singleton per document)

const versionBase = {
  version: z.number().int().positive(),
  proposedBy: IdentitySchema,
  proposedAt: z.string().datetime(),
};

const proposedFields = {
  ...versionBase,
  status: z.literal('proposed'),
};
const acceptedFields = {
  ...versionBase,
  status: z.literal('accepted'),
  acceptedBy: IdentitySchema,
  acceptedAt: z.string().datetime(),
};
const rejectedFields = {
  ...versionBase,
  status: z.literal('rejected'),
  rejectedBy: IdentitySchema,
  rejectedAt: z.string().datetime(),
  rejectionReason: z.string(),
};
// A previously-accepted artifact that was removed from the doc. Tombstone: it stays in the
// version chain (history is preserved) but the projection drops it. `spec` is the body that
// was live at retraction time, kept so the rationale/diff still reads naturally.
const retractedFields = {
  ...versionBase,
  status: z.literal('retracted'),
  retractedBy: IdentitySchema,
  retractedAt: z.string().datetime(),
  retractionReason: z.string().optional(),
};

// Operation artifact
const opBase = {
  kind: z.literal('operation'),
  documentName: DocumentNameSchema,
  method: HttpMethodSchema,
  path: PathSchema,
  spec: OperationSpecSchema,
};

export const OperationArtifactSchema = z.discriminatedUnion('status', [
  z.object({ ...opBase, ...proposedFields }),
  z.object({ ...opBase, ...acceptedFields }),
  z.object({ ...opBase, ...rejectedFields }),
  z.object({ ...opBase, ...retractedFields }),
]);
export type OperationArtifact = z.infer<typeof OperationArtifactSchema>;

// Schema artifact
const schemaBase = {
  kind: z.literal('schema'),
  documentName: DocumentNameSchema,
  name: SchemaNameSchema,
  spec: JSONSchemaSchema,
};

export const SchemaArtifactSchema = z.discriminatedUnion('status', [
  z.object({ ...schemaBase, ...proposedFields }),
  z.object({ ...schemaBase, ...acceptedFields }),
  z.object({ ...schemaBase, ...rejectedFields }),
  z.object({ ...schemaBase, ...retractedFields }),
]);
export type SchemaArtifact = z.infer<typeof SchemaArtifactSchema>;

// Convention artifact (singleton per document)
const conventionBase = {
  kind: z.literal('convention'),
  documentName: DocumentNameSchema,
  spec: ConventionSpecSchema,
};

export const ConventionArtifactSchema = z.discriminatedUnion('status', [
  z.object({ ...conventionBase, ...proposedFields }),
  z.object({ ...conventionBase, ...acceptedFields }),
  z.object({ ...conventionBase, ...rejectedFields }),
  z.object({ ...conventionBase, ...retractedFields }),
]);
export type ConventionArtifact = z.infer<typeof ConventionArtifactSchema>;

// --- summaries (for list endpoints — no spec body, just metadata) ---

const summaryShape = {
  currentVersion: z.number().int().positive().nullable(),
  currentAcceptedAt: z.string().datetime().nullable(),
  latestProposedVersion: z.number().int().positive().nullable(),
  latestProposedBy: IdentitySchema.nullable(),
  latestProposedAt: z.string().datetime().nullable(),
  latestDelta: z.string().nullable(),
};

const EndpointSummarySchema = z.object({
  method: HttpMethodSchema,
  path: PathSchema,
  summary: z.string().nullable(),
  ...summaryShape,
});
export type EndpointSummary = z.infer<typeof EndpointSummarySchema>;

const SchemaSummarySchema = z.object({
  name: SchemaNameSchema,
  ...summaryShape,
});
export type SchemaSummary = z.infer<typeof SchemaSummarySchema>;

// --- events (kind-discriminated, ordered by id within a document) ---

const eventBaseShape = {
  id: CursorSchema,
  documentName: DocumentNameSchema,
  createdAt: z.string().datetime(),
};

const MessageEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('message'),
  from: IdentitySchema,
  text: z.string().min(1),
});

const ArtifactProposedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_proposed'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
  delta: z.string().nullable(), // null for v1; compact "+a; -b" summary for v≥2
});

const ArtifactAcceptedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_accepted'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
  /** Optional acceptance rationale — surfaces in event/render output so the reason rides on the
   *  accept event instead of needing a separate `brackish send`. */
  reason: z.string().min(1).optional(),
});

const ArtifactRejectedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_rejected'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
  reason: z.string(),
});

const ArtifactWithdrawnEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_withdrawn'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
});

/** A previously-accepted artifact was tombstoned — emitted per target when a retraction is
 *  accepted by the peer. */
const ArtifactRetractedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_retracted'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
  reason: z.string().optional(),
});

// --- retraction lifecycle (a negotiated, grouped removal) ---

export const RetractionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('endpoint'), method: HttpMethodSchema, path: PathSchema }),
  z.object({ kind: z.literal('schema'), name: SchemaNameSchema }),
  z.object({ kind: z.literal('convention') }),
]);
export type RetractionTarget = z.infer<typeof RetractionTargetSchema>;

const RetractionProposedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('retraction_proposed'),
  from: IdentitySchema,
  retractionId: z.number().int().positive(),
  targets: z.array(RetractionTargetSchema),
  reason: z.string().optional(),
});

const RetractionAcceptedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('retraction_accepted'),
  from: IdentitySchema,
  retractionId: z.number().int().positive(),
});

const RetractionRejectedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('retraction_rejected'),
  from: IdentitySchema,
  retractionId: z.number().int().positive(),
  reason: z.string(),
});

const RetractionWithdrawnEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('retraction_withdrawn'),
  from: IdentitySchema,
  retractionId: z.number().int().positive(),
});

const DocumentCreatedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('document_created'),
  by: IdentitySchema,
});

export const EventSchema = z.discriminatedUnion('kind', [
  MessageEventSchema,
  ArtifactProposedEventSchema,
  ArtifactAcceptedEventSchema,
  ArtifactRejectedEventSchema,
  ArtifactWithdrawnEventSchema,
  ArtifactRetractedEventSchema,
  RetractionProposedEventSchema,
  RetractionAcceptedEventSchema,
  RetractionRejectedEventSchema,
  RetractionWithdrawnEventSchema,
  DocumentCreatedEventSchema,
]);
export type Event = z.infer<typeof EventSchema>;

// --- inbox summary ---

const InboxEntrySchema = z.object({
  documentName: DocumentNameSchema,
  newCount: z.number().int().nonnegative(),
  lastEventAt: z.string().datetime(),
  lastFrom: IdentitySchema.nullable(),
  lastKind: z.string(),
  preview: z.string(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

// --- JSON Patch (RFC 6902 — subset: add/remove/replace; we don't emit move/copy/test) ---

const JsonPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: z.string() }),
  z.object({ op: z.literal('replace'), path: z.string(), value: z.unknown() }),
]);
export type JsonPatchOp = z.infer<typeof JsonPatchOpSchema>;

const JsonPatchSchema = z.array(JsonPatchOpSchema);
export type JsonPatch = z.infer<typeof JsonPatchSchema>;

// --- wire request bodies ---

export const CreateDocumentRequestSchema = z.object({
  name: DocumentNameSchema,
});

export const SendMessageRequestSchema = z.object({
  text: z.string().min(1),
});

export const SendMessageResponseSchema = z.object({ event: EventSchema });

export const ProposeEndpointRequestSchema = z.object({
  method: HttpMethodSchema,
  path: PathSchema,
  spec: OperationSpecSchema,
});

export const ProposeSchemaRequestSchema = z.object({
  name: SchemaNameSchema,
  spec: JSONSchemaSchema,
});

export const ProposeConventionRequestSchema = z.object({
  spec: ConventionSpecSchema,
});

// Per-item options inside a propose-batch request. Matches the per-propose query-string flags
// (`?expected_version=N|new`, `?force=true`) but as a structured field on each batch item so
// each artifact can carry its own concurrency intent.
const BatchItemOptionsSchema = z
  .object({
    expectedVersion: z.union([z.literal('new'), z.number().int().positive()]).optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type BatchItemOptions = z.infer<typeof BatchItemOptionsSchema>;

// Shared overlay shape: a coordinated set of convention + schemas + endpoints. propose-batch
// requires at least one (the .refine below); validate reuses the bare shape and allows empty
// (= "validate the current doc with nothing overlaid").
const batchOverlayShape = {
  convention: z
    .object({ spec: ConventionSpecSchema, options: BatchItemOptionsSchema.optional() })
    .optional(),
  schemas: z
    .array(
      z.object({
        name: SchemaNameSchema,
        spec: JSONSchemaSchema,
        options: BatchItemOptionsSchema.optional(),
      }),
    )
    .optional(),
  endpoints: z
    .array(
      z.object({
        method: HttpMethodSchema,
        path: PathSchema,
        spec: OperationSpecSchema,
        options: BatchItemOptionsSchema.optional(),
      }),
    )
    .optional(),
};

export const ProposeBatchRequestSchema = z
  .object(batchOverlayShape)
  .strict()
  .refine(
    (b) =>
      b.convention !== undefined ||
      (b.schemas !== undefined && b.schemas.length > 0) ||
      (b.endpoints !== undefined && b.endpoints.length > 0),
    {
      message: 'propose-batch request must include at least one of: convention, schemas, endpoints',
    },
  );
export type ProposeBatchRequest = z.infer<typeof ProposeBatchRequestSchema>;

// Dry-run validation: same overlay as propose-batch, but empty is allowed (validate the
// current doc as-is). The server assembles and meta-schema-validates without committing.
export const ValidateRequestSchema = z.object(batchOverlayShape).strict();
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const DeliverResponseSchema = z.object({ delivered: z.number().int().nonnegative() });
export type DeliverResponse = z.infer<typeof DeliverResponseSchema>;

export const HeldResponseSchema = z.object({
  held: z.array(z.object({ documentName: DocumentNameSchema, held: z.number().int().positive() })),
});
export type HeldResponse = z.infer<typeof HeldResponseSchema>;

export const ValidateResponseSchema = z.object({
  valid: z.boolean(),
  /** 'wide' when an overlay was supplied (accepted + proposed + overlay, as propose-batch would
   *  assemble it); 'accepted' for the bare current-doc check. */
  view: z.enum(['accepted', 'wide']),
  issues: z.array(
    z.object({
      severity: z.enum(['error', 'warn']),
      field: z.string(),
      message: z.string(),
    }),
  ),
});
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

// Atomic removal of a coordinated set of accepted artifacts. Like propose-batch but in reverse:
// the server assembles the accepted doc with these removed, requires it still valid (no orphaned
// $ref), and commits all-or-nothing. Effective immediately (unilateral); the peer sees the
// artifact_retracted events.
export const RetractRequestSchema = z
  .object({
    endpoints: z.array(z.object({ method: HttpMethodSchema, path: PathSchema })).optional(),
    schemas: z.array(SchemaNameSchema).optional(),
    convention: z.boolean().optional(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (b) =>
      (b.endpoints !== undefined && b.endpoints.length > 0) ||
      (b.schemas !== undefined && b.schemas.length > 0) ||
      b.convention === true,
    { message: 'retract request must name at least one of: endpoints, schemas, convention' },
  );
export type RetractRequest = z.infer<typeof RetractRequestSchema>;

// A retraction is a NEGOTIATED, grouped removal: one party proposes removing a coordinated set of
// accepted artifacts; the peer accepts (the whole set is tombstoned, atomically, validated
// fully-valid-after) or rejects (nothing changes). Mirrors the propose/accept lifecycle in the
// removal direction. The artifacts stay live while the retraction is pending.
// (RetractionTargetSchema is defined up near the events, which reference it.)
const retractionBase = {
  id: z.number().int().positive(),
  documentName: DocumentNameSchema,
  targets: z.array(RetractionTargetSchema).min(1),
  reason: z.string().optional(),
  proposedBy: IdentitySchema,
  proposedAt: z.string().datetime(),
};

export const RetractionSchema = z.discriminatedUnion('status', [
  z.object({ ...retractionBase, status: z.literal('proposed') }),
  z.object({
    ...retractionBase,
    status: z.literal('accepted'),
    acceptedBy: IdentitySchema,
    acceptedAt: z.string().datetime(),
  }),
  z.object({
    ...retractionBase,
    status: z.literal('rejected'),
    rejectedBy: IdentitySchema,
    rejectedAt: z.string().datetime(),
    rejectionReason: z.string(),
  }),
  z.object({
    ...retractionBase,
    status: z.literal('withdrawn'),
    withdrawnAt: z.string().datetime(),
  }),
]);
export type Retraction = z.infer<typeof RetractionSchema>;

export const RetractionResponseSchema = z.object({ retraction: RetractionSchema });
export type RetractionResponse = z.infer<typeof RetractionResponseSchema>;

export const RetractionListResponseSchema = z.object({
  retractions: z.array(RetractionSchema),
});
export type RetractionListResponse = z.infer<typeof RetractionListResponseSchema>;

export const ProposeBatchResponseSchema = z.object({
  succeeded: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('convention'), envelope: ConventionArtifactSchema }),
      z.object({
        kind: z.literal('schema'),
        name: SchemaNameSchema,
        envelope: SchemaArtifactSchema,
      }),
      z.object({
        kind: z.literal('endpoint'),
        method: HttpMethodSchema,
        path: PathSchema,
        envelope: OperationArtifactSchema,
      }),
    ]),
  ),
});
export type ProposeBatchResponse = z.infer<typeof ProposeBatchResponseSchema>;

// Atomic batch accept: name a coordinated set of proposed artifacts (schemas + endpoints) to accept
// together. The server overlays all of them onto the accepted doc, meta-schema-validates once, and
// commits all-or-nothing — so a mutually-referencing set accepts together (the per-item path would
// reject the first for a dangling $ref), and a set that would wedge the doc is refused whole.
// (Convention is singleton — accept it on its own. One rationale rides the whole batch.)
export const AcceptBatchRequestSchema = z
  .object({
    endpoints: z.array(z.object({ method: HttpMethodSchema, path: PathSchema })).optional(),
    schemas: z.array(SchemaNameSchema).optional(),
    rationale: z.string().min(1).optional(),
    // Opt-in: also accept the still-proposed schemas the named targets $ref (transitively), in the
    // same atomic batch. Default off → an endpoint whose schema isn't accepted yet is refused.
    includeDependencies: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) =>
      (b.endpoints !== undefined && b.endpoints.length > 0) ||
      (b.schemas !== undefined && b.schemas.length > 0),
    { message: 'accept-batch request must name at least one of: endpoints, schemas' },
  );
export type AcceptBatchRequest = z.infer<typeof AcceptBatchRequestSchema>;

// Counter = atomically reject the current proposed version + propose a replacement. One discriminated
// route serves all three nouns (the spec type differs per kind). `reason` is the reject rationale.
export const CounterRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('endpoint'),
    method: HttpMethodSchema,
    path: PathSchema,
    spec: OperationSpecSchema,
    reason: z.string().min(1),
    options: BatchItemOptionsSchema.optional(),
  }),
  z.object({
    kind: z.literal('schema'),
    name: SchemaNameSchema,
    spec: JSONSchemaSchema,
    reason: z.string().min(1),
    options: BatchItemOptionsSchema.optional(),
  }),
  z.object({
    kind: z.literal('convention'),
    spec: ConventionSpecSchema,
    reason: z.string().min(1),
    options: BatchItemOptionsSchema.optional(),
  }),
]);
export type CounterRequest = z.infer<typeof CounterRequestSchema>;

export const CounterResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('endpoint'), envelope: OperationArtifactSchema }),
  z.object({ kind: z.literal('schema'), envelope: SchemaArtifactSchema }),
  z.object({ kind: z.literal('convention'), envelope: ConventionArtifactSchema }),
]);

const AcceptedItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schema'), name: SchemaNameSchema, envelope: SchemaArtifactSchema }),
  z.object({
    kind: z.literal('endpoint'),
    method: HttpMethodSchema,
    path: PathSchema,
    envelope: OperationArtifactSchema,
  }),
]);

export const AcceptBatchResponseSchema = z.object({
  // The artifacts you named.
  accepted: z.array(AcceptedItemSchema),
  // Extra artifacts pulled in by --include-dependencies (the proposed $ref-closure), accepted in the
  // same transaction. Empty unless --include-dependencies pulled something in.
  dependencies: z.array(AcceptedItemSchema).default([]),
});

export const RejectArtifactRequestSchema = z.object({
  reason: z.string().min(1),
});

/** Optional acceptance rationale that rides on the artifact_accepted event. */
export const AcceptArtifactRequestSchema = z.object({
  reason: z.string().min(1).optional(),
});

export const CreateInviteRequestSchema = z.object({
  identity: IdentitySchema,
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24 * 30),
  /** Optional list of documents the redeeming party is automatically granted membership of. */
  grantDocs: z.array(DocumentNameSchema).optional(),
});

/** Add a member to a document. Role is mandatory ('owner' for co-owner; 'member' for read+propose). */
export const AddMemberRequestSchema = z.object({
  identity: IdentitySchema,
  role: z.enum(['owner', 'member']),
});

export const DocumentMemberSchema = z.object({
  identity: IdentitySchema,
  role: z.enum(['owner', 'member']),
  grantedBy: IdentitySchema,
  grantedAt: z.string().datetime(),
});
export type DocumentMember = z.infer<typeof DocumentMemberSchema>;

export const RedeemInviteRequestSchema = z.object({
  inviteToken: TokenSchema,
});

// --- wire response bodies ---

export const EventListResponseSchema = z.object({
  events: z.array(EventSchema),
  cursor: CursorSchema,
});
export type EventListResponse = z.infer<typeof EventListResponseSchema>;

export const WhoamiResponseSchema = z.object({
  identity: IdentitySchema,
  serverVersion: z.string(),
});
export type WhoamiResponse = z.infer<typeof WhoamiResponseSchema>;

export const InboxResponseSchema = z.object({
  identity: IdentitySchema,
  documents: z.array(InboxEntrySchema),
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const InviteCreatedResponseSchema = z.object({
  inviteToken: TokenSchema,
  identity: IdentitySchema,
  expiresAt: z.string().datetime(),
});
export type InviteCreatedResponse = z.infer<typeof InviteCreatedResponseSchema>;

export const ConnectResponseSchema = z.object({
  identity: IdentitySchema,
  token: TokenSchema,
});
export type ConnectResponse = z.infer<typeof ConnectResponseSchema>;

export const PartiesResponseSchema = z.object({
  parties: z.array(PartySchema),
});
export type PartiesResponse = z.infer<typeof PartiesResponseSchema>;

export const EndpointListResponseSchema = z.object({
  endpoints: z.array(EndpointSummarySchema),
});
export type EndpointListResponse = z.infer<typeof EndpointListResponseSchema>;

export const SchemaListResponseSchema = z.object({
  schemas: z.array(SchemaSummarySchema),
});
export type SchemaListResponse = z.infer<typeof SchemaListResponseSchema>;

export const DiffResponseSchema = z.object({
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  patch: JsonPatchSchema,
});
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

// --- rationale (per-version history) ---

const RationaleEntrySchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(['proposed', 'accepted', 'rejected']),
  proposedBy: IdentitySchema,
  proposedAt: z.string().datetime(),
  acceptedBy: IdentitySchema.optional(),
  acceptedAt: z.string().datetime().optional(),
  rejectedBy: IdentitySchema.optional(),
  rejectedAt: z.string().datetime().optional(),
  rejectionReason: z.string().optional(),
  delta: z.string().nullable(),
  spec: z.unknown(),
});
export type RationaleEntryWire = z.infer<typeof RationaleEntrySchema>;

export const RationaleResponseSchema = z.object({
  endpoints: z.record(z.string(), z.array(RationaleEntrySchema)),
  schemas: z.record(z.string(), z.array(RationaleEntrySchema)),
  convention: z.array(RationaleEntrySchema),
});
export type RationaleResponse = z.infer<typeof RationaleResponseSchema>;

// --- identity-key helpers ---

/** Compose the storage identity key for an operation (used as a single string for routes + DB). */
export function operationIdentityKey(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Parse an operation identity key back into (method, path). Throws on bad input. */
export function parseOperationIdentityKey(key: string): { method: HttpMethod; path: string } {
  const space = key.indexOf(' ');
  if (space < 0) throw new Error(`invalid operation identity key: ${key}`);
  const method = key.slice(0, space).toLowerCase();
  const path = key.slice(space + 1);
  const m = HttpMethodSchema.safeParse(method);
  if (!m.success) throw new Error(`invalid HTTP method in identity key: ${method}`);
  return { method: m.data, path };
}

/** Constant identity key for the singleton convention artifact in a document. */
export const CONVENTION_KEY = 'convention';

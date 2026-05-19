// Wire-protocol + domain schemas. Single source of truth for shapes and runtime validation.
// Pattern: <Name>Schema is the zod value; <Name> is the inferred type. Import both as needed.
//
// v0.2 model: artifacts are kind-discriminated (operation/schema/convention), each carrying a
// typed `spec` that's a subset of the corresponding OpenAPI 3.1 object (with passthrough so
// unknown fields and x-brackish-* extensions round-trip cleanly). No more freeform `kind: string`
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
export const CursorSchema = z.number().int().nonnegative();
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

export const ArtifactKindSchema = z.enum(['operation', 'schema', 'convention']);

export type Identity = z.infer<typeof IdentitySchema>;
export type DocumentName = z.infer<typeof DocumentNameSchema>;
export type SchemaName = z.infer<typeof SchemaNameSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;
export type Path = z.infer<typeof PathSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// --- document ---

export const DocumentSchema = z.object({
  name: DocumentNameSchema,
  createdBy: IdentitySchema,
  createdAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

// --- party (TCP auth subject) ---

export const PartySchema = z.object({
  identity: IdentitySchema,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
});
export type Party = z.infer<typeof PartySchema>;

// --- invite ---

export const InviteSchema = z.object({
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
// .passthrough() is load-bearing here — it preserves x-brackish-* extensions and any OpenAPI
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

export const EndpointSummarySchema = z.object({
  method: HttpMethodSchema,
  path: PathSchema,
  summary: z.string().nullable(),
  ...summaryShape,
});
export type EndpointSummary = z.infer<typeof EndpointSummarySchema>;

export const SchemaSummarySchema = z.object({
  name: SchemaNameSchema,
  ...summaryShape,
});
export type SchemaSummary = z.infer<typeof SchemaSummarySchema>;

export const ConventionSummarySchema = z.object({
  ...summaryShape,
});
export type ConventionSummary = z.infer<typeof ConventionSummarySchema>;

// --- events (kind-discriminated, ordered by id within a document) ---

const eventBaseShape = {
  id: CursorSchema,
  documentName: DocumentNameSchema,
  createdAt: z.string().datetime(),
};

export const MessageEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('message'),
  from: IdentitySchema,
  text: z.string().min(1),
});

export const ArtifactProposedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_proposed'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
  delta: z.string().nullable(), // null for v1; compact "+a; -b" summary for v≥2
});

export const ArtifactAcceptedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_accepted'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
});

export const ArtifactRejectedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_rejected'),
  from: IdentitySchema,
  artifactKind: ArtifactKindSchema,
  identityKey: z.string(),
  version: z.number().int().positive(),
  reason: z.string(),
});

export const DocumentCreatedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('document_created'),
  by: IdentitySchema,
});

export const EventSchema = z.discriminatedUnion('kind', [
  MessageEventSchema,
  ArtifactProposedEventSchema,
  ArtifactAcceptedEventSchema,
  ArtifactRejectedEventSchema,
  DocumentCreatedEventSchema,
]);
export type Event = z.infer<typeof EventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type ArtifactProposedEvent = z.infer<typeof ArtifactProposedEventSchema>;
export type ArtifactAcceptedEvent = z.infer<typeof ArtifactAcceptedEventSchema>;
export type ArtifactRejectedEvent = z.infer<typeof ArtifactRejectedEventSchema>;
export type DocumentCreatedEvent = z.infer<typeof DocumentCreatedEventSchema>;

// --- inbox summary ---

export const InboxEntrySchema = z.object({
  documentName: DocumentNameSchema,
  newCount: z.number().int().nonnegative(),
  lastEventAt: z.string().datetime(),
  lastFrom: IdentitySchema.nullable(),
  lastKind: z.string(),
  preview: z.string(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

// --- JSON Patch (RFC 6902 — subset: add/remove/replace; we don't emit move/copy/test) ---

export const JsonPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: z.string() }),
  z.object({ op: z.literal('replace'), path: z.string(), value: z.unknown() }),
]);
export type JsonPatchOp = z.infer<typeof JsonPatchOpSchema>;

export const JsonPatchSchema = z.array(JsonPatchOpSchema);
export type JsonPatch = z.infer<typeof JsonPatchSchema>;

// --- wire request bodies ---

export const CreateDocumentRequestSchema = z.object({
  name: DocumentNameSchema,
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

export const SendMessageRequestSchema = z.object({
  text: z.string().min(1),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = z.object({ event: EventSchema });
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const ProposeEndpointRequestSchema = z.object({
  method: HttpMethodSchema,
  path: PathSchema,
  spec: OperationSpecSchema,
});
export type ProposeEndpointRequest = z.infer<typeof ProposeEndpointRequestSchema>;

export const ProposeSchemaRequestSchema = z.object({
  name: SchemaNameSchema,
  spec: JSONSchemaSchema,
});
export type ProposeSchemaRequest = z.infer<typeof ProposeSchemaRequestSchema>;

export const ProposeConventionRequestSchema = z.object({
  spec: ConventionSpecSchema,
});
export type ProposeConventionRequest = z.infer<typeof ProposeConventionRequestSchema>;

export const RejectArtifactRequestSchema = z.object({
  reason: z.string().min(1),
});
export type RejectArtifactRequest = z.infer<typeof RejectArtifactRequestSchema>;

export const CreateInviteRequestSchema = z.object({
  identity: IdentitySchema,
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24 * 30),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

export const RedeemInviteRequestSchema = z.object({
  inviteToken: TokenSchema,
});
export type RedeemInviteRequest = z.infer<typeof RedeemInviteRequestSchema>;

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

// Wire-protocol + domain schemas. Single source of truth for shapes and runtime validation.
// Pattern: <Name>Schema is the zod value; <Name> is the inferred type. Import both as needed.

import { z } from 'zod';

// --- scalars ---

const nameRegex = /^[a-z][a-z0-9_-]{0,63}$/;

export const IdentitySchema = z
  .string()
  .regex(nameRegex, 'identity must match /^[a-z][a-z0-9_-]{0,63}$/');
export const ThreadNameSchema = z
  .string()
  .regex(nameRegex, 'thread name must match /^[a-z][a-z0-9_-]{0,63}$/');
export const ArtifactNameSchema = z
  .string()
  .regex(nameRegex, 'artifact name must match /^[a-z][a-z0-9_-]{0,63}$/');
export const ArtifactKindSchema = z.string().min(1).max(64);
export const CursorSchema = z.number().int().nonnegative();
export const TokenSchema = z.string().min(16).max(256);

export type Identity = z.infer<typeof IdentitySchema>;
export type ThreadName = z.infer<typeof ThreadNameSchema>;
export type ArtifactName = z.infer<typeof ArtifactNameSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type Token = z.infer<typeof TokenSchema>;

// --- thread ---

export const ThreadSchema = z.object({
  name: ThreadNameSchema,
  createdBy: IdentitySchema,
  createdAt: z.string().datetime(),
});
export type Thread = z.infer<typeof ThreadSchema>;

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

// --- artifact version (status-discriminated) ---

const artifactBaseShape = {
  threadName: ThreadNameSchema,
  name: ArtifactNameSchema,
  version: z.number().int().positive(),
  kind: ArtifactKindSchema,
  content: z.string(),
  proposedBy: IdentitySchema,
  proposedAt: z.string().datetime(),
};

export const ProposedArtifactVersionSchema = z.object({
  ...artifactBaseShape,
  status: z.literal('proposed'),
});

export const AcceptedArtifactVersionSchema = z.object({
  ...artifactBaseShape,
  status: z.literal('accepted'),
  acceptedBy: IdentitySchema,
  acceptedAt: z.string().datetime(),
});

export const RejectedArtifactVersionSchema = z.object({
  ...artifactBaseShape,
  status: z.literal('rejected'),
  rejectedBy: IdentitySchema,
  rejectedAt: z.string().datetime(),
  rejectionReason: z.string(),
});

export const ArtifactVersionSchema = z.discriminatedUnion('status', [
  ProposedArtifactVersionSchema,
  AcceptedArtifactVersionSchema,
  RejectedArtifactVersionSchema,
]);
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export type ProposedArtifactVersion = z.infer<typeof ProposedArtifactVersionSchema>;
export type AcceptedArtifactVersion = z.infer<typeof AcceptedArtifactVersionSchema>;
export type RejectedArtifactVersion = z.infer<typeof RejectedArtifactVersionSchema>;

// Lightweight summary for `artifact list` — no content blob.
export const ArtifactSummarySchema = z.object({
  name: ArtifactNameSchema,
  kind: ArtifactKindSchema,
  currentVersion: z.number().int().positive().nullable(),
  currentAcceptedAt: z.string().datetime().nullable(),
  latestProposedVersion: z.number().int().positive().nullable(),
  latestProposedBy: IdentitySchema.nullable(),
  latestProposedAt: z.string().datetime().nullable(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

// --- events (kind-discriminated, ordered by id within a thread) ---

const eventBaseShape = {
  id: CursorSchema,
  threadName: ThreadNameSchema,
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
  artifactName: ArtifactNameSchema,
  artifactKind: ArtifactKindSchema,
  version: z.number().int().positive(),
});

export const ArtifactAcceptedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_accepted'),
  from: IdentitySchema,
  artifactName: ArtifactNameSchema,
  version: z.number().int().positive(),
});

export const ArtifactRejectedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('artifact_rejected'),
  from: IdentitySchema,
  artifactName: ArtifactNameSchema,
  version: z.number().int().positive(),
  reason: z.string(),
});

export const ThreadCreatedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('thread_created'),
  by: IdentitySchema,
});

export const EventSchema = z.discriminatedUnion('kind', [
  MessageEventSchema,
  ArtifactProposedEventSchema,
  ArtifactAcceptedEventSchema,
  ArtifactRejectedEventSchema,
  ThreadCreatedEventSchema,
]);
export type Event = z.infer<typeof EventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type ArtifactProposedEvent = z.infer<typeof ArtifactProposedEventSchema>;
export type ArtifactAcceptedEvent = z.infer<typeof ArtifactAcceptedEventSchema>;
export type ArtifactRejectedEvent = z.infer<typeof ArtifactRejectedEventSchema>;
export type ThreadCreatedEvent = z.infer<typeof ThreadCreatedEventSchema>;

// --- inbox summary ---

export const InboxEntrySchema = z.object({
  threadName: ThreadNameSchema,
  newCount: z.number().int().nonnegative(),
  lastEventAt: z.string().datetime(),
  lastFrom: IdentitySchema.nullable(),
  lastKind: z.string(),
  preview: z.string(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

// --- wire request bodies ---

export const CreateThreadRequestSchema = z.object({
  name: ThreadNameSchema,
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

export const SendMessageRequestSchema = z.object({
  text: z.string().min(1),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const ProposeArtifactRequestSchema = z.object({
  name: ArtifactNameSchema,
  kind: ArtifactKindSchema,
  content: z.string(),
});
export type ProposeArtifactRequest = z.infer<typeof ProposeArtifactRequestSchema>;

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
  threads: z.array(InboxEntrySchema),
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

export const ArtifactListResponseSchema = z.object({
  artifacts: z.array(ArtifactSummarySchema),
});
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;

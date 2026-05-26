// Replayable move log shape for `brackish demo`. The harness's `--demo-data` flag emits files in
// this format; the demo seed walks the array and dispatches one client call per move.

import { z } from 'zod';
import {
  ConventionSpecSchema,
  DocumentNameSchema,
  HttpMethodSchema,
  IdentitySchema,
  JSONSchemaSchema,
  OperationSpecSchema,
  PathSchema,
  SchemaNameSchema,
} from './models.js';

const DemoMoveSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('create_document'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    doc: DocumentNameSchema,
  }),
  z.object({
    t: z.literal('message'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    text: z.string(),
  }),
  z.object({
    t: z.literal('propose_convention'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    spec: ConventionSpecSchema,
  }),
  z.object({
    t: z.literal('propose_schema'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    name: SchemaNameSchema,
    spec: JSONSchemaSchema,
  }),
  z.object({
    t: z.literal('propose_endpoint'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    method: HttpMethodSchema,
    path: PathSchema,
    spec: OperationSpecSchema,
  }),
  z.object({
    t: z.literal('accept_convention'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    reason: z.string().min(1).optional(),
  }),
  z.object({
    t: z.literal('accept_schema'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    name: SchemaNameSchema,
    reason: z.string().min(1).optional(),
  }),
  z.object({
    t: z.literal('accept_endpoint'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    method: HttpMethodSchema,
    path: PathSchema,
    reason: z.string().min(1).optional(),
  }),
  z.object({
    t: z.literal('reject_convention'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    reason: z.string(),
  }),
  z.object({
    t: z.literal('reject_schema'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    name: SchemaNameSchema,
    reason: z.string(),
  }),
  z.object({
    t: z.literal('reject_endpoint'),
    actor: IdentitySchema,
    at: z.string().datetime().optional(),
    method: HttpMethodSchema,
    path: PathSchema,
    reason: z.string(),
  }),
]);
export type DemoMove = z.infer<typeof DemoMoveSchema>;

export const DemoDataSchema = z.object({
  document: DocumentNameSchema,
  moves: z.array(DemoMoveSchema),
});
export type DemoData = z.infer<typeof DemoDataSchema>;

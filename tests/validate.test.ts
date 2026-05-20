import { describe, expect, it } from 'vitest';
import { validateDocument } from '../src/lib/validate.js';

const okDoc = {
  openapi: '3.1.0',
  info: { title: 'X', version: '1.0.0' },
  paths: { '/h': { get: { responses: { '200': { description: 'OK' } } } } },
};

describe('validateDocument', () => {
  it('passes a minimal valid OpenAPI 3.1 doc', async () => {
    const r = await validateDocument(okDoc);
    expect(r.errors).toEqual([]);
  });

  it('rejects an http-typed securityScheme missing the required `scheme` (the bearer-no-scheme case)', async () => {
    const r = await validateDocument({
      ...okDoc,
      components: { securitySchemes: { bearerAuth: { type: 'http' } } },
    });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(
      r.errors.some(
        (e) =>
          e.field.includes('securitySchemes.bearerAuth') &&
          e.message.toLowerCase().includes('scheme'),
      ),
    ).toBe(true);
  });

  it('rejects an unresolvable $ref with a string-form error (surfaced as a single root issue)', async () => {
    const r = await validateDocument({
      ...okDoc,
      components: {
        schemas: {
          MessageList: {
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: { $ref: '#/components/schemas/Message' },
              },
            },
          },
        },
      },
    });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]?.field).toBe('(refs)');
    expect(r.errors[0]?.message).toContain('Message');
  });

  it('rejects a response missing the required `description`', async () => {
    const r = await validateDocument({
      ...okDoc,
      paths: { '/h': { get: { responses: { '200': {} } } } },
    });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.some((e) => e.message.toLowerCase().includes('description'))).toBe(true);
  });
});

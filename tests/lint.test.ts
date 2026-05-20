import { describe, expect, it } from 'vitest';
import { lintConventionSpec, lintEndpointSpec, lintSchemaSpec } from '../src/lib/lint.js';

// Minimal valid bodies for each kind; tests start from these and mutate.
const okOperation = {
  responses: { '200': { description: 'OK' } },
};
const okSchema = { type: 'object', properties: { id: { type: 'string' } } };
const okConvention = {
  info: { title: 'Orders API', version: '1.0.0' },
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
};

describe('lintEndpointSpec', () => {
  it('passes a minimal valid Operation', async () => {
    const r = await lintEndpointSpec('get', '/health', okOperation);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('reports a missing path-parameters entry for each {placeholder}', async () => {
    const r = await lintEndpointSpec('get', '/users/{user_id}/posts/{post_id}', okOperation);
    expect(r.errors.length).toBe(2);
    expect(r.errors[0]?.message).toContain('{user_id}');
    expect(r.errors[1]?.message).toContain('{post_id}');
  });

  it('passes when each placeholder has a matching path parameter', async () => {
    const r = await lintEndpointSpec('get', '/users/{user_id}', {
      ...okOperation,
      parameters: [{ name: 'user_id', in: 'path', required: true, schema: { type: 'string' } }],
    });
    expect(r.errors).toEqual([]);
  });

  it('flags an orphan parameters[i].name (declared but not in the path)', async () => {
    const r = await lintEndpointSpec('get', '/users', {
      ...okOperation,
      parameters: [{ name: 'wrong', in: 'path', required: true, schema: { type: 'string' } }],
    });
    // brackish cross-check flags the orphan; meta-schema may also flag (required:true + in:path mismatch
    // is brackish-defined, not OpenAPI-defined, so the meta-schema is silent).
    expect(r.errors.some((e) => e.field === 'parameters[0].name')).toBe(true);
  });

  it('catches a typo between the path and the parameter (hook-id vs hook_id)', async () => {
    const r = await lintEndpointSpec('get', '/hooks/{hook_id}', {
      ...okOperation,
      parameters: [{ name: 'hook-id', in: 'path', required: true, schema: { type: 'string' } }],
    });
    // Both directions fire: placeholder hook_id is undeclared AND parameter hook-id is orphaned.
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('warns on a malformed $ref (missing #/components/ prefix)', async () => {
    const r = await lintEndpointSpec('get', '/users', {
      responses: {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: { $ref: 'components/schemas/User' } } },
        },
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.message).toContain('#/components/');
  });

  it('errors when responses is missing entirely', async () => {
    const r = await lintEndpointSpec('get', '/health', { summary: 'health check' });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors[0]?.field).toContain('responses');
  });

  it('errors when the spec is not an object', async () => {
    const r = await lintEndpointSpec('get', '/health', 'oops');
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('lintSchemaSpec', () => {
  it('passes a plain JSON Schema object', async () => {
    const r = await lintSchemaSpec('User', okSchema);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('errors when the spec is not an object', async () => {
    const r = await lintSchemaSpec('User', 'not a schema');
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('warns on a malformed $ref deep in the schema', async () => {
    const r = await lintSchemaSpec('Order', {
      type: 'object',
      properties: {
        user: { $ref: '/components/schemas/User' },
      },
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.field).toContain('$ref');
  });
});

describe('lintConventionSpec', () => {
  it('passes a minimal valid Convention', async () => {
    const r = await lintConventionSpec(okConvention);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('errors when info.title is missing', async () => {
    const r = await lintConventionSpec({ info: { version: '1.0.0' } });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.some((e) => e.field.includes('title'))).toBe(true);
  });

  it('errors when info.version is missing', async () => {
    const r = await lintConventionSpec({ info: { title: 'X' } });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.some((e) => e.field.includes('version'))).toBe(true);
  });

  it('errors when security references an undeclared scheme', async () => {
    const r = await lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ apiKey: [] }],
    });
    expect(r.errors.some((e) => e.field === 'security[0]')).toBe(true);
    const undeclaredErr = r.errors.find((e) => e.field === 'security[0]');
    expect(undeclaredErr?.message).toContain('apiKey');
    expect(undeclaredErr?.message).toContain('bearer');
  });

  it('passes when security references a declared scheme', async () => {
    const r = await lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
    });
    expect(r.errors).toEqual([]);
  });

  it('errors on an undeclared scheme even when no schemes are declared', async () => {
    const r = await lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      security: [{ bearer: [] }],
    });
    expect(r.errors.some((e) => e.field === 'security[0]')).toBe(true);
    const undeclaredErr = r.errors.find((e) => e.field === 'security[0]');
    expect(undeclaredErr?.message).toContain('declared: none');
  });

  it('errors on an invalid x-brackish.naming value', async () => {
    const r = await lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      'x-brackish': { naming: 'PascalCase' },
    });
    expect(r.errors.some((e) => e.field === 'x-brackish.naming')).toBe(true);
  });

  it('accepts camelCase and snake_case', async () => {
    const a = await lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      'x-brackish': { naming: 'camelCase' },
    });
    expect(a.errors).toEqual([]);
    const b = await lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      'x-brackish': { naming: 'snake_case' },
    });
    expect(b.errors).toEqual([]);
  });
});

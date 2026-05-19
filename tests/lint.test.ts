import { describe, expect, it } from 'vitest';
import { lintConventionSpec, lintEndpointSpec, lintSchemaSpec } from '../src/lib/lint.js';

// Minimal valid bodies for each kind; tests start from these and mutate.
const okOperation = {
  responses: { '200': { description: 'OK' } },
};
const okSchema = { type: 'object', properties: { id: { type: 'string' } } };
const okConvention = {
  info: { title: 'Orders API', version: '1.0.0' },
  securitySchemes: { bearer: { type: 'http' } },
};

describe('lintEndpointSpec', () => {
  it('passes a minimal valid Operation', () => {
    const r = lintEndpointSpec('get', '/health', okOperation);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('reports a missing path-parameters entry for each {placeholder}', () => {
    const r = lintEndpointSpec('get', '/users/{user_id}/posts/{post_id}', okOperation);
    expect(r.errors.length).toBe(2);
    expect(r.errors[0]?.message).toContain('{user_id}');
    expect(r.errors[1]?.message).toContain('{post_id}');
  });

  it('passes when each placeholder has a matching path parameter', () => {
    const r = lintEndpointSpec('get', '/users/{user_id}', {
      ...okOperation,
      parameters: [{ name: 'user_id', in: 'path', required: true, schema: { type: 'string' } }],
    });
    expect(r.errors).toEqual([]);
  });

  it('flags an orphan parameters[i].name (declared but not in the path)', () => {
    const r = lintEndpointSpec('get', '/users', {
      ...okOperation,
      parameters: [{ name: 'wrong', in: 'path', required: true, schema: { type: 'string' } }],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.field).toBe('parameters[0].name');
    expect(r.errors[0]?.message).toContain('"wrong"');
  });

  it('catches a typo between the path and the parameter (hook-id vs hook_id)', () => {
    const r = lintEndpointSpec('get', '/hooks/{hook_id}', {
      ...okOperation,
      parameters: [{ name: 'hook-id', in: 'path', required: true, schema: { type: 'string' } }],
    });
    // Both directions fire: placeholder hook_id is undeclared AND parameter hook-id is orphaned.
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('warns on a malformed $ref (missing #/components/ prefix)', () => {
    const r = lintEndpointSpec('get', '/users', {
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

  it('errors when responses is missing entirely', () => {
    const r = lintEndpointSpec('get', '/health', { summary: 'health check' });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors[0]?.field).toContain('responses');
  });

  it('errors when the spec is not an object', () => {
    const r = lintEndpointSpec('get', '/health', 'oops');
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('lintSchemaSpec', () => {
  it('passes a plain JSON Schema object', () => {
    const r = lintSchemaSpec('User', okSchema);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('errors when the spec is not an object', () => {
    const r = lintSchemaSpec('User', 'not a schema');
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('warns on a malformed $ref deep in the schema', () => {
    const r = lintSchemaSpec('Order', {
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
  it('passes a minimal valid Convention', () => {
    const r = lintConventionSpec(okConvention);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('errors when info.title is missing', () => {
    const r = lintConventionSpec({ info: { version: '1.0.0' } });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.some((e) => e.field.includes('title'))).toBe(true);
  });

  it('errors when info.version is missing', () => {
    const r = lintConventionSpec({ info: { title: 'X' } });
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.errors.some((e) => e.field.includes('version'))).toBe(true);
  });

  it('errors when security references an undeclared scheme', () => {
    const r = lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      securitySchemes: { bearer: { type: 'http' } },
      security: [{ apiKey: [] }],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain('apiKey');
    expect(r.errors[0]?.message).toContain('bearer');
  });

  it('passes when security references a declared scheme', () => {
    const r = lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      securitySchemes: { bearer: { type: 'http' } },
      security: [{ bearer: [] }],
    });
    expect(r.errors).toEqual([]);
  });

  it('errors on an undeclared scheme even when no schemes are declared', () => {
    const r = lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      security: [{ bearer: [] }],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain('declared: none');
  });

  it('errors on an invalid x-brackish.naming value', () => {
    const r = lintConventionSpec({
      info: { title: 'X', version: '1.0.0' },
      'x-brackish': { naming: 'PascalCase' },
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.field).toBe('x-brackish.naming');
  });

  it('accepts camelCase and snake_case', () => {
    expect(
      lintConventionSpec({
        info: { title: 'X', version: '1.0.0' },
        'x-brackish': { naming: 'camelCase' },
      }).errors,
    ).toEqual([]);
    expect(
      lintConventionSpec({
        info: { title: 'X', version: '1.0.0' },
        'x-brackish': { naming: 'snake_case' },
      }).errors,
    ).toEqual([]);
  });
});

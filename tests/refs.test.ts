import { describe, expect, it } from 'vitest';
import { collectSchemaRefs, findBlockingRefs } from '../src/lib/refs.js';

describe('collectSchemaRefs', () => {
  it('finds a single top-level ref', () => {
    expect(collectSchemaRefs({ $ref: '#/components/schemas/User' })).toEqual(['User']);
  });

  it('finds refs nested inside properties and arrays', () => {
    const spec = {
      type: 'object',
      properties: {
        author: { $ref: '#/components/schemas/User' },
        replies: {
          type: 'array',
          items: { $ref: '#/components/schemas/Message' },
        },
      },
    };
    expect(collectSchemaRefs(spec)).toEqual(['Message', 'User']);
  });

  it('deduplicates repeated refs', () => {
    const spec = {
      oneOf: [{ $ref: '#/components/schemas/User' }, { $ref: '#/components/schemas/User' }],
    };
    expect(collectSchemaRefs(spec)).toEqual(['User']);
  });

  it('ignores non-component refs (external URLs, parameters, responses)', () => {
    const spec = {
      $ref: 'https://example.com/schemas/Foo',
      properties: {
        a: { $ref: '#/components/parameters/PageSize' },
        b: { $ref: '#/components/responses/Created' },
        c: { $ref: '#/components/schemas/Real' },
      },
    };
    expect(collectSchemaRefs(spec)).toEqual(['Real']);
  });

  it('returns empty for null, primitives, empty objects', () => {
    expect(collectSchemaRefs(null)).toEqual([]);
    expect(collectSchemaRefs('foo')).toEqual([]);
    expect(collectSchemaRefs(42)).toEqual([]);
    expect(collectSchemaRefs({})).toEqual([]);
  });

  it('handles an operation spec with refs in requestBody + responses', () => {
    const op = {
      summary: 'Create a message',
      requestBody: {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/MessageCreate' } },
        },
      },
      responses: {
        '201': {
          description: 'created',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Message' } },
          },
        },
        '400': {
          description: 'bad',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Error' } },
          },
        },
      },
    };
    expect(collectSchemaRefs(op)).toEqual(['Error', 'Message', 'MessageCreate']);
  });
});

describe('findBlockingRefs', () => {
  it('returns refs that are not in the accepted set', () => {
    const spec = {
      properties: {
        author: { $ref: '#/components/schemas/User' },
        topic: { $ref: '#/components/schemas/Topic' },
      },
    };
    const accepted = new Set(['User']);
    expect(findBlockingRefs(spec, accepted)).toEqual(['Topic']);
  });

  it('returns empty when every ref is accepted', () => {
    const spec = {
      properties: {
        author: { $ref: '#/components/schemas/User' },
      },
    };
    expect(findBlockingRefs(spec, new Set(['User']))).toEqual([]);
  });

  it('returns empty when the spec has no refs', () => {
    expect(findBlockingRefs({ type: 'object' }, new Set())).toEqual([]);
  });
});

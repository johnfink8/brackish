import { describe, expect, it } from 'vitest';
import { compactSummary, generatePatch } from '../src/diff.js';

describe('generatePatch', () => {
  it('returns no ops for equal values', () => {
    expect(generatePatch({ a: 1 }, { a: 1 })).toEqual([]);
    expect(generatePatch([1, 2, 3], [1, 2, 3])).toEqual([]);
    expect(generatePatch(null, null)).toEqual([]);
  });

  it('emits replace for a value change at a shallow key', () => {
    expect(generatePatch({ a: 1 }, { a: 2 })).toEqual([{ op: 'replace', path: '/a', value: 2 }]);
  });

  it('emits add for new keys', () => {
    expect(generatePatch({}, { a: 1 })).toEqual([{ op: 'add', path: '/a', value: 1 }]);
  });

  it('emits remove for missing keys', () => {
    expect(generatePatch({ a: 1 }, {})).toEqual([{ op: 'remove', path: '/a' }]);
  });

  it('walks nested objects', () => {
    const before = { user: { id: '1', email: 'a@x' } };
    const after = { user: { id: '1', email: 'b@x' } };
    expect(generatePatch(before, after)).toEqual([
      { op: 'replace', path: '/user/email', value: 'b@x' },
    ]);
  });

  it('escapes slashes in keys per RFC 6901', () => {
    const before = { 'application/json': { a: 1 } };
    const after = { 'application/json': { a: 2 } };
    expect(generatePatch(before, after)).toEqual([
      { op: 'replace', path: '/application~1json/a', value: 2 },
    ]);
  });

  it('treats type mismatches as whole-subtree replacement', () => {
    expect(generatePatch({ a: 1 }, { a: { b: 2 } })).toEqual([
      { op: 'replace', path: '/a', value: { b: 2 } },
    ]);
  });

  it('diffs arrays index-by-index', () => {
    expect(generatePatch([1, 2, 3], [1, 5, 3])).toEqual([
      { op: 'replace', path: '/1', value: 5 },
    ]);
    expect(generatePatch([1, 2], [1, 2, 3])).toEqual([{ op: 'add', path: '/2', value: 3 }]);
    expect(generatePatch([1, 2, 3], [1, 2])).toEqual([{ op: 'remove', path: '/2' }]);
  });

  it('handles array vs object as a whole-subtree replace', () => {
    expect(generatePatch([1, 2], { a: 1 })).toEqual([
      { op: 'replace', path: '', value: { a: 1 } },
    ]);
  });

  it('handles undefined → value as add', () => {
    expect(generatePatch(undefined, { a: 1 })).toEqual([
      { op: 'add', path: '', value: { a: 1 } },
    ]);
  });

  it('round-trips a representative OpenAPI Operation diff', () => {
    const before = {
      summary: 'Create user',
      responses: {
        '201': { description: 'created' },
      },
    };
    const after = {
      summary: 'Create user',
      responses: {
        '201': { description: 'created' },
        '409': { description: 'email taken' },
      },
      'x-brackish-idempotent': true,
    };
    const patch = generatePatch(before, after);
    expect(patch).toContainEqual({
      op: 'add',
      path: '/responses/409',
      value: { description: 'email taken' },
    });
    expect(patch).toContainEqual({
      op: 'add',
      path: '/x-brackish-idempotent',
      value: true,
    });
  });
});

describe('compactSummary', () => {
  it('renders empty patch as empty string', () => {
    expect(compactSummary([])).toBe('');
  });

  it('renders add/remove/replace with +/-/~ sigils', () => {
    const summary = compactSummary([
      { op: 'add', path: '/a/b', value: 1 },
      { op: 'remove', path: '/c' },
      { op: 'replace', path: '/d/e', value: 'x' },
    ]);
    expect(summary).toBe('+a.b; -c; ~d.e');
  });

  it('unescapes JSON Pointer escapes in the dotted form', () => {
    const summary = compactSummary([
      {
        op: 'replace',
        path: '/responses/201/content/application~1json/schema',
        value: { type: 'object' },
      },
    ]);
    expect(summary).toBe('~responses.201.content.application/json.schema');
  });

  it("represents the root with '(root)'", () => {
    expect(compactSummary([{ op: 'replace', path: '', value: { a: 1 } }])).toBe('~(root)');
  });
});

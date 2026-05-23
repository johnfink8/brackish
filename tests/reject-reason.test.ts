import { describe, expect, it } from 'vitest';
import { resolveRejectReason } from '../src/cli/common.js';

describe('resolveRejectReason', () => {
  it('accepts the positional form (back-compat)', () => {
    expect(resolveRejectReason('shape needs more fields', undefined)).toBe(
      'shape needs more fields',
    );
  });

  it('accepts the --rationale flag form', () => {
    expect(resolveRejectReason(undefined, 'shape needs more fields')).toBe(
      'shape needs more fields',
    );
  });

  it('errors when both are passed (ambiguous)', () => {
    expect(() => resolveRejectReason('a', 'b')).toThrow(/positionally OR via --rationale/);
  });

  it('errors when neither is passed', () => {
    expect(() => resolveRejectReason(undefined, undefined)).toThrow(/reason is required/);
  });

  it('errors when both are empty strings (treats empty as missing)', () => {
    expect(() => resolveRejectReason('', undefined)).toThrow(/reason is required/);
    expect(() => resolveRejectReason(undefined, '')).toThrow(/reason is required/);
  });
});

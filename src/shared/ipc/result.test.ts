import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, describeError, err, isOk, ok } from './result';

describe('ok / err', () => {
  it('carries the value on success', () => {
    const result = ok({ id: 7 });
    expect(result).toEqual({ ok: true, value: { id: 7 } });
    expect(isOk(result)).toBe(true);
  });

  it('omits `detail` entirely when none is given', () => {
    const result = err('not-found', 'Missing.');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    // Absent rather than `undefined`: an explicit undefined survives neither
    // exactOptionalPropertyTypes nor structured cloning cleanly.
    expect('detail' in result.error).toBe(false);
  });

  it('keeps `detail` when given', () => {
    const result = err('internal', 'Boom.', 'stack trace here');
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.detail).toBe('stack trace here');
  });
});

describe('error codes', () => {
  it('are unique', () => {
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
  });
});

describe('describeError', () => {
  it('prefers the stack of a real Error', () => {
    const described = describeError(new Error('kaboom'));
    expect(described).toContain('kaboom');
  });

  it('stringifies non-Errors rather than losing them', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
  });
});

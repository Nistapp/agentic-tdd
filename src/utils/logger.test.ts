import { describe, it, expect } from 'vitest';
import { sanitizeLogPayload } from './logger';

describe('sanitizeLogPayload', () => {
  const longStr = 'x'.repeat(5000);

  // -- info level: truncation --

  it('truncates strings > 400 chars at info level', () => {
    const result = sanitizeLogPayload(longStr, 'info');
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeLessThan(longStr.length);
    expect(result).toContain('[Truncated: 5000 characters total]');
  });

  it('truncates after stripping C0 controls at info level', () => {
    const dirty = '\x00A'.repeat(201) + 'B'.repeat(5000);
    const result = sanitizeLogPayload(dirty, 'info') as string;
    expect(result).not.toContain('\x00');
    expect(result).toContain('[Truncated:');
    expect(result.startsWith('A'.repeat(201))).toBe(true);
  });

  it('leaves strings <= 400 chars unchanged at info level', () => {
    const short = 'hello world';
    const result = sanitizeLogPayload(short, 'info');
    expect(result).toBe(short);
  });

  it('does not truncate strings <= 400 chars at info level with controls', () => {
    const short = '\x00\x1Fhello';
    const result = sanitizeLogPayload(short, 'info');
    expect(result).toBe('hello');
  });

  it('case-insensitive: INFO truncates', () => {
    const result = sanitizeLogPayload(longStr, 'INFO');
    expect(result).toContain('[Truncated:');
  });

  it('case-insensitive: Info truncates', () => {
    const result = sanitizeLogPayload(longStr, 'Info');
    expect(result).toContain('[Truncated: 5000 characters total]');
  });

  // -- debug level: preserve entire string --

  it('preserves full string at debug level', () => {
    const result = sanitizeLogPayload(longStr, 'debug');
    expect(result).toBe(longStr);
    expect((result as string).length).toBe(5000);
  });

  it('preserves full string at trace level', () => {
    const result = sanitizeLogPayload(longStr, 'trace');
    expect(result).toBe(longStr);
  });

  it('strips C0 controls at debug level, preserves \\n and \\t', () => {
    const dirty = 'line1\n\x00line2\t\x1Fline3\x07';
    const result = sanitizeLogPayload(dirty, 'debug');
    expect(result).toBe('line1\nline2\tline3');
  });

  it('strips C0 controls at debug level, preserves \\r', () => {
    const dirty = '\x00\n\t\r';
    const result = sanitizeLogPayload(dirty, 'debug');
    expect(result).toBe('\n\t\r');
  });

  it('case-insensitive: DEBUG preserves', () => {
    const result = sanitizeLogPayload(longStr, 'DEBUG');
    expect(result).toBe(longStr);
  });

  // -- deeply nested objects --

  it('recurses into nested objects at info level', () => {
    const nested = {
      a: 'x'.repeat(5000),
      b: {
        c: 'y'.repeat(3000),
        d: 'short',
      },
    };
    const result = sanitizeLogPayload(nested, 'info') as Record<string, unknown>;

    expect((result.a as string).length).toBeLessThan(5000);
    expect(result.a).toContain('[Truncated: 5000 characters total]');

    expect(((result.b as Record<string, unknown>).c as string).length).toBeLessThan(3000);
    expect((result.b as Record<string, unknown>).c).toContain('[Truncated: 3000 characters total]');

    expect((result.b as Record<string, unknown>).d).toBe('short');
  });

  it('recurses into arrays at info level', () => {
    const arr = ['x'.repeat(5000), { inner: 'y'.repeat(3000) }, 'short'];
    const result = sanitizeLogPayload(arr, 'info') as unknown[];

    expect(result[0]).toContain('[Truncated: 5000 characters total]');
    expect((result[1] as Record<string, unknown>).inner).toContain('[Truncated: 3000 characters total]');
    expect(result[2]).toBe('short');
  });

  it('preserves deeply nested strings at debug level', () => {
    const nested = {
      a: 'x'.repeat(5000),
      b: {
        c: ['y'.repeat(3000), { d: 'z'.repeat(2000) }],
      },
    };
    const result = sanitizeLogPayload(nested, 'debug') as Record<string, unknown>;

    expect((result.a as string).length).toBe(5000);
    expect(((result.b as Record<string, unknown>).c as unknown[])[0]).toBe('y'.repeat(3000));
    expect(
      (((result.b as Record<string, unknown>).c as unknown[])[1] as Record<string, unknown>).d,
    ).toBe('z'.repeat(2000));
  });

  // -- non-string values pass through --

  it('passes through numbers unchanged', () => {
    expect(sanitizeLogPayload(42, 'info')).toBe(42);
    expect(sanitizeLogPayload(-3.14, 'debug')).toBe(-3.14);
  });

  it('passes through booleans unchanged', () => {
    expect(sanitizeLogPayload(true, 'info')).toBe(true);
    expect(sanitizeLogPayload(false, 'debug')).toBe(false);
  });

  it('passes through null and undefined', () => {
    expect(sanitizeLogPayload(null, 'info')).toBeNull();
    expect(sanitizeLogPayload(undefined, 'debug')).toBeUndefined();
  });

  it('clones dates at info level', () => {
    const d = new Date(2020, 0, 1);
    const result = sanitizeLogPayload(d, 'info');
    expect(result instanceof Date).toBe(true);
    expect((result as Date).getTime()).toBe(d.getTime());
    expect(result).not.toBe(d);
  });

  it('clones dates at debug level', () => {
    const d = new Date(2025, 5, 15);
    const result = sanitizeLogPayload(d, 'debug');
    expect(result instanceof Date).toBe(true);
    expect((result as Date).getTime()).toBe(d.getTime());
    expect(result).not.toBe(d);
  });

  // -- mixed payload --

  it('handles mixed payload with strings, numbers, booleans, nulls', () => {
    const payload = {
      key: 'x'.repeat(5000),
      count: 42,
      flag: false,
      nothing: null,
      arr: ['x'.repeat(1000), 7, true],
    };
    const result = sanitizeLogPayload(payload, 'info') as Record<string, unknown>;

    expect(result.key).toContain('[Truncated: 5000 characters total]');
    expect(result.count).toBe(42);
    expect(result.flag).toBe(false);
    expect(result.nothing).toBeNull();
    expect((result.arr as unknown[])[0]).toContain('[Truncated: 1000 characters total]');
    expect((result.arr as unknown[])[1]).toBe(7);
    expect((result.arr as unknown[])[2]).toBe(true);
  });

  it('handles warning level like info (truncates)', () => {
    const result = sanitizeLogPayload(longStr, 'warn');
    expect(result).toContain('[Truncated: 5000 characters total]');
  });

  it('handles error level like info (truncates)', () => {
    const result = sanitizeLogPayload(longStr, 'error');
    expect(result).toContain('[Truncated: 5000 characters total]');
  });

  it('handles unknown levels like info (truncates)', () => {
    const result = sanitizeLogPayload(longStr, 'fatal');
    expect(result).toContain('[Truncated: 5000 characters total]');
  });

  // -- input not mutated (deep clone) --

  it('does not mutate the input object at info level', () => {
    const original = { a: 'x'.repeat(5000), b: 'short' };
    const copy = { a: original.a, b: original.b };
    sanitizeLogPayload(original, 'info');

    expect(original.a.length).toBe(5000);
    expect(original.b).toBe('short');
    expect(original.a).toBe(copy.a);
    expect(original.b).toBe(copy.b);
  });

  it('does not mutate the input object at debug level', () => {
    const original = { a: '\x00hello\nworld\x1F' };
    sanitizeLogPayload(original, 'debug');

    expect(original.a).toBe('\x00hello\nworld\x1F');
  });

  it('does not mutate nested input arrays', () => {
    const original = { items: ['x'.repeat(5000), 'y'.repeat(3000)] };
    sanitizeLogPayload(original, 'info');

    expect(original.items.length).toBe(2);
    expect((original.items[0] as string).length).toBe(5000);
    expect((original.items[1] as string).length).toBe(3000);
  });

  it('returns a distinct object (deep clone)', () => {
    const original = { a: 'hello' };
    const result = sanitizeLogPayload(original, 'info');
    expect(result).not.toBe(original);
    expect(result).toEqual(original);
  });

  // -- edge: empty objects and arrays --

  it('handles empty object', () => {
    expect(sanitizeLogPayload({}, 'info')).toEqual({});
    expect(sanitizeLogPayload({}, 'debug')).toEqual({});
  });

  it('handles empty array', () => {
    expect(sanitizeLogPayload([], 'info')).toEqual([]);
    expect(sanitizeLogPayload([], 'debug')).toEqual([]);
  });

  it('handles empty string', () => {
    expect(sanitizeLogPayload('', 'info')).toBe('');
    expect(sanitizeLogPayload('', 'debug')).toBe('');
  });

  // -- edge: exactly 400 chars --

  it('does not truncate at exactly 400 chars (info)', () => {
    const s = 'y'.repeat(400);
    const result = sanitizeLogPayload(s, 'info');
    expect(result).toBe(s);
  });

  it('truncates at exactly 401 chars (info)', () => {
    const s = 'y'.repeat(401);
    const result = sanitizeLogPayload(s, 'info');
    expect(result).toContain('[Truncated: 401 characters total]');
    expect(result).not.toBe(s);
  });

  // -- edge: string full of only C0 controls --

  it('returns empty string when payload is all C0 controls (info)', () => {
    expect(sanitizeLogPayload('\x00\x07\x1F', 'info')).toBe('');
  });

  it('returns empty string when payload is all C0 controls (debug)', () => {
    expect(sanitizeLogPayload('\x00\x07\x1F', 'debug')).toBe('');
  });
});

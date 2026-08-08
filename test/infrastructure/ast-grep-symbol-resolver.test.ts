import { describe, it, expect } from 'vitest';

import { AstGrepSymbolResolver } from '../../src/infrastructure/ast-grep-symbol-resolver.js';

// ---------------------------------------------------------------------------
// Positive: TypeScript source
// ---------------------------------------------------------------------------

const TS_SOURCE = `
function foo(a: number): number {
  const x = a + 1;
  return x * 2;
}

class Bar {
  private val: number;

  constructor(v: number) {
    this.val = v;
  }

  methodA(n: number): number {
    const y = this.val + n;
    return y;
  }

  static helper(): string {
    return "static-helper";
  }
}

export function topLevel(): string {
  return "top-level";
}

function* generate(): Generator<number> {
  yield 1;
}

const adder = (a: number, b: number): number => {
  return a + b;
};

class Baz {
  fieldFn = (x: string): string => {
    return x.toUpperCase();
  };
}
`;

describe('AstGrepSymbolResolver', () => {
  const resolver = new AstGrepSymbolResolver();

  // -----------------------------------------------------------------------
  // Positive cases — TypeScript
  // -----------------------------------------------------------------------

  it('maps a range inside a top-level function to its name', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 2, end: 2 }],
    );
    expect(symbols).toEqual(['foo']);
  });

  it('maps a range inside a class method to ClassName.methodName', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 14, end: 14 }],
    );
    expect(symbols).toEqual(['Bar.methodA']);
  });

  it('maps a range inside a constructor', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 10, end: 10 }],
    );
    expect(symbols).toEqual(['Bar.constructor']);
  });

  it('maps a range inside a static method', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 19, end: 19 }],
    );
    expect(symbols).toEqual(['Bar.helper']);
  });

  it('maps a range inside an exported top-level function', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 24, end: 24 }],
    );
    expect(symbols).toEqual(['topLevel']);
  });

  it('maps a range inside a generator function', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 28, end: 28 }],
    );
    expect(symbols).toEqual(['generate']);
  });

  it('maps a range inside a top-level arrow function to its variable name', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 33, end: 33 }],
    );
    expect(symbols).toEqual(['adder']);
  });

  it('maps a range inside a class field arrow to ClassName.fieldName', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 39, end: 39 }],
    );
    expect(symbols).toEqual(['Baz.fieldFn']);
  });

  it('maps a range inside a class body (outside any method) to the class name', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 8, end: 8 }],
    );
    expect(symbols).toEqual(['Bar']);
  });

  // -----------------------------------------------------------------------
  // Positive — JavaScript source
  // -----------------------------------------------------------------------

  it('works with JavaScript source using .js extension', () => {
    const jsSource = `
function calculate(x) {
  return x * x;
}
class MathUtil {
  add(a, b) {
    return a + b;
  }
}
`;
    const symbols = resolver.mapRangesToSymbols(
      'test.js',
      jsSource,
      [{ start: 6, end: 6 }],
    );
    expect(symbols).toEqual(['MathUtil.add']);
  });

  // -----------------------------------------------------------------------
  // Envelope cases
  // -----------------------------------------------------------------------

  it('returns empty array for a range at top level (no enclosing symbol)', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [{ start: 1, end: 1 }],
    );
    expect(symbols).toEqual([]);
  });

  it('returns empty array for an unsupported file extension', () => {
    const symbols = resolver.mapRangesToSymbols(
      'README.md',
      '# Hello World',
      [{ start: 1, end: 1 }],
    );
    expect(symbols).toEqual([]);
  });

  it('returns empty array for .gherkin files (no parser available)', () => {
    const symbols = resolver.mapRangesToSymbols(
      'spec.gherkin',
      'Feature: Login',
      [{ start: 1, end: 1 }],
    );
    expect(symbols).toEqual([]);
  });

  it('returns empty array for empty ranges input', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      'function foo() {}',
      [],
    );
    expect(symbols).toEqual([]);
  });

  it('returns empty array for malformed source (does not throw)', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      '{{{{{broken syntax}}}}',
      [{ start: 1, end: 1 }],
    );
    expect(symbols).toEqual([]);
  });

  it('returns empty array for empty source', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      '',
      [{ start: 1, end: 1 }],
    );
    expect(symbols).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Deduplication and multiple ranges
  // -----------------------------------------------------------------------

  it('deduplicates the same enclosing symbol from multiple ranges', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [
        { start: 2, end: 2 },
        { start: 3, end: 3 },
        { start: 4, end: 4 },
      ],
    );
    expect(symbols).toEqual(['foo']);
  });

  it('returns multiple unique symbols from ranges in different functions', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [
        { start: 2, end: 2 },
        { start: 14, end: 14 },
        { start: 24, end: 24 },
      ],
    );
    expect(symbols).toEqual(['Bar.methodA', 'foo', 'topLevel']);
  });

  it('returns sorted results', () => {
    const symbols = resolver.mapRangesToSymbols(
      'test.ts',
      TS_SOURCE,
      [
        { start: 39, end: 39 },
        { start: 2, end: 2 },
        { start: 24, end: 24 },
      ],
    );
    expect(symbols).toEqual(['Baz.fieldFn', 'foo', 'topLevel']);
  });

  // -----------------------------------------------------------------------
  // .tsx extension
  // -----------------------------------------------------------------------

  it('works with .tsx extension', () => {
    const tsxSource = `
function Component() {
  return <div>hello</div>;
}
`;
    const symbols = resolver.mapRangesToSymbols(
      'Component.tsx',
      tsxSource,
      [{ start: 3, end: 3 }],
    );
    expect(symbols).toEqual(['Component']);
  });

  // -----------------------------------------------------------------------
  // CSS / HTML — parseable but no function-like nodes
  // -----------------------------------------------------------------------

  it('returns empty for CSS (no enclosing symbols)', () => {
    const symbols = resolver.mapRangesToSymbols(
      'styles.css',
      'body { color: red; }',
      [{ start: 1, end: 1 }],
    );
    expect(symbols).toEqual([]);
  });
});

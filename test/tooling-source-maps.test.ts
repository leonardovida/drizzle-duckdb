import { createRequire } from 'node:module';
import type { SourceMapConsumer as SourceMapConsumerInstance } from 'source-map-js';
import { describe, expect, test } from 'vitest';

// Exercise the source-map consumer actually used by Vite's CSS toolchain,
// rather than a separately installed copy of source-map-js.
const require = createRequire(import.meta.url);
const requireFromVite = createRequire(require.resolve('vite/package.json'));
const requireFromPostcss = createRequire(requireFromVite.resolve('postcss'));
const postcss: typeof import('postcss').default = requireFromVite('postcss');
// The library accepts serialized maps, including indexed maps, although its
// declarations only describe basic map objects.
const {
  SourceMapConsumer,
}: {
  SourceMapConsumer: new (map: string) => SourceMapConsumerInstance;
} = requireFromPostcss('source-map-js');

function indexedMap(offsetLine: number) {
  return {
    version: 3,
    sections: [
      {
        offset: { line: offsetLine, column: 0 },
        map: {
          version: 3,
          sources: ['input.css'],
          sourcesContent: ['a { color: red }'],
          names: [],
          mappings: 'AAAA',
        },
      },
    ],
  };
}

describe('development CSS source maps', () => {
  test('rejects oversized indexed offsets before generating a map', () => {
    // CVE-2026-93749: construction used to accept this offset. Avoid
    // serializing it on an affected version, which can exhaust CPU or memory.
    expect(
      () => new SourceMapConsumer(JSON.stringify(indexedMap(100_000_000)))
    ).toThrow(/must not exceed/);
  });

  test('preserves CSS and original positions through a valid source map', () => {
    const result = postcss([
      {
        postcssPlugin: 'test-color-transform',
        Declaration(declaration) {
          declaration.value = 'blue';
        },
      },
    ]).process('a { color: red }', {
      from: 'compiled.css',
      to: 'output.css',
      map: {
        prev: indexedMap(0).sections[0].map,
        inline: false,
        annotation: false,
      },
    });

    expect(result.css).toBe('a { color: blue }');
    expect(result.map).toBeDefined();
    const consumer = new SourceMapConsumer(result.map!.toString());
    expect(consumer.originalPositionFor({ line: 1, column: 0 })).toEqual({
      source: 'input.css',
      line: 1,
      column: 0,
      name: null,
    });
    expect(consumer.sourceContentFor('input.css')).toBe('a { color: red }');
  });
});

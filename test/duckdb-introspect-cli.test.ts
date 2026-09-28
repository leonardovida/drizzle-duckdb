import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliUsageError, parseArgs } from '../src/bin/duckdb-introspect-args.ts';

const binPath = path.join(process.cwd(), 'src/bin/duckdb-introspect.ts');

describe('duckdb-introspect parseArgs', () => {
  test('parses value and boolean flags', () => {
    const options = parseArgs([
      '--url',
      ':memory:',
      '--db',
      'analytics',
      '--schema',
      'a, b,,c',
      '--out',
      'out/schema.ts',
      '--json',
      'out/meta.json',
      '--include-views',
      '--use-pg-time',
      '--import-base',
      '../helpers.ts',
    ]);
    expect(options).toMatchObject({
      help: false,
      url: ':memory:',
      database: 'analytics',
      schemas: ['a', 'b', 'c'],
      outFile: path.resolve(process.cwd(), 'out/schema.ts'),
      outMeta: path.resolve(process.cwd(), 'out/meta.json'),
      includeViews: true,
      useCustomTimeTypes: false,
      importBasePath: '../helpers.ts',
    });
  });

  test('uses defaults when only --url is given', () => {
    const options = parseArgs(['--url', 'db.duckdb']);
    expect(options.outFile).toBe(
      path.resolve(process.cwd(), 'drizzle/schema.ts')
    );
    expect(options.outMeta).toBeUndefined();
    expect(options.allDatabases).toBe(false);
    expect(options.useCustomTimeTypes).toBe(true);
    expect(options.ducklake).toBeUndefined();
  });

  test('parses DuckLake options', () => {
    const options = parseArgs([
      '--url',
      ':memory:',
      '--ducklake-catalog',
      './lake.duckdb',
      '--ducklake-alias',
      'lake',
      '--ducklake-no-use',
      '--ducklake-data-path',
      './data',
      '--ducklake-read-only',
      '--ducklake-data-inlining-row-limit',
      '10',
    ]);
    expect(options.ducklake).toEqual({
      catalog: './lake.duckdb',
      alias: 'lake',
      use: false,
      attachOptions: {
        dataPath: './data',
        readOnly: true,
        dataInliningRowLimit: 10,
      },
    });
  });

  test('returns help without validating the rest', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--url', ':memory:', '-h', '--bogus']).help).toBe(true);
  });

  test('rejects a value flag followed by another flag', () => {
    expect(() => parseArgs(['--url', '--out', 'x.ts'])).toThrow(
      new CliUsageError('Missing value for --url')
    );
  });

  test('rejects a value flag at the end of argv', () => {
    expect(() => parseArgs(['--url', ':memory:', '--out'])).toThrow(
      'Missing value for --out'
    );
  });

  test('rejects unknown options and stray arguments', () => {
    expect(() => parseArgs(['--url', ':memory:', '--bogus'])).toThrow(
      'Unknown option --bogus'
    );
    expect(() => parseArgs(['--url', ':memory:', 'extra'])).toThrow(
      'Unexpected argument "extra"'
    );
  });

  test('rejects invalid numeric values', () => {
    for (const value of ['abc', '1.5', '-1', '']) {
      expect(() =>
        parseArgs([
          '--ducklake-catalog',
          'x',
          '--ducklake-data-inlining-row-limit',
          value,
        ])
      ).toThrow(CliUsageError);
    }
  });

  test('rejects DuckLake options without a catalog', () => {
    expect(() => parseArgs(['--url', ':memory:', '--ducklake-load'])).toThrow(
      'DuckLake requires --ducklake-catalog'
    );
  });
});

describe('duckdb-introspect binary', () => {
  test('exits with code 2 on usage errors without opening a database', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'duckdb-introspect-'));
    try {
      const result = spawnSync('bun', [binPath, '--url', '--out', 'x.ts'], {
        cwd,
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Missing value for --url');
      expect(fs.readdirSync(cwd)).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

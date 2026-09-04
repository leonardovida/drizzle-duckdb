import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import {
  compareBenchmarks,
  loadNormalizedFile,
  normalizePerfFile,
  parseArgs,
  renderComparison,
} from '../scripts/compare-perf.ts';
import {
  buildVitestArgs,
  parseArgs as parseRunArgs,
} from '../scripts/run-perf.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('compare-perf', () => {
  test('normalizes current action-bench rows', () => {
    const rows = normalizePerfFile([
      { name: 'scan', unit: 'ops/s', value: 100, range: 1.5 },
    ]);

    expect(rows).toEqual([
      { name: 'scan', opsPerSecond: 100, relativeMargin: 1.5 },
    ]);
  });

  test('normalizes legacy perf output', () => {
    const rows = normalizePerfFile({
      results: [{ name: 'scan', hz: 100, rme: 1.5 }],
    });

    expect(rows).toEqual([
      { name: 'scan', opsPerSecond: 100, relativeMargin: 1.5 },
    ]);
  });

  test('loads current and legacy files from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-perf-'));
    tempDirs.push(dir);

    const currentPath = join(dir, 'current.json');
    const legacyPath = join(dir, 'legacy.json');

    writeFileSync(
      currentPath,
      JSON.stringify([{ name: 'scan', value: 100, range: 2 }]),
      'utf8'
    );
    writeFileSync(
      legacyPath,
      JSON.stringify({ results: [{ name: 'scan', hz: 90, rme: 3 }] }),
      'utf8'
    );

    await expect(loadNormalizedFile(currentPath)).resolves.toEqual([
      { name: 'scan', opsPerSecond: 100, relativeMargin: 2 },
    ]);
    await expect(loadNormalizedFile(legacyPath)).resolves.toEqual([
      { name: 'scan', opsPerSecond: 90, relativeMargin: 3 },
    ]);
  });

  test('flags only negative deltas as regression risk', () => {
    const rows = compareBenchmarks(
      [{ name: 'scan', opsPerSecond: 100, relativeMargin: 1 }],
      [
        { name: 'scan', opsPerSecond: 92, relativeMargin: 1 },
        { name: 'insert', opsPerSecond: 130, relativeMargin: 1 },
      ],
      5
    );

    expect(rows).toEqual([
      {
        name: 'insert',
        previous: undefined,
        next: { name: 'insert', opsPerSecond: 130, relativeMargin: 1 },
        percentChange: undefined,
        isRegressionRisk: false,
      },
      {
        name: 'scan',
        previous: { name: 'scan', opsPerSecond: 100, relativeMargin: 1 },
        next: { name: 'scan', opsPerSecond: 92, relativeMargin: 1 },
        percentChange: -8,
        isRegressionRisk: true,
      },
    ]);
  });

  test('renders missing and regression rows', () => {
    const output = renderComparison([
      {
        name: 'insert',
        previous: undefined,
        next: { name: 'insert', opsPerSecond: 130, relativeMargin: 1 },
        percentChange: undefined,
        isRegressionRisk: false,
      },
      {
        name: 'scan',
        previous: { name: 'scan', opsPerSecond: 100, relativeMargin: 1 },
        next: { name: 'scan', opsPerSecond: 92, relativeMargin: 1 },
        percentChange: -8,
        isRegressionRisk: true,
      },
    ]);

    expect(output).toContain('insert: missing in old run');
    expect(output).toContain(
      'scan: 100.00 -> 92.00 ops/sec (-8.00% slower) regression risk'
    );
  });

  test('parses threshold flag and positional args', () => {
    expect(parseArgs(['--threshold', '7.5', 'old.json', 'new.json'])).toEqual({
      previousPath: 'old.json',
      nextPath: 'new.json',
      threshold: 7.5,
    });
  });
});

describe('package script targets', () => {
  test('local bun script targets exist', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };

    const missingTargets = Object.values(packageJson.scripts ?? [])
      .map((script) => {
        const match = script.match(/^bun run (scripts\/[^\s]+)$/);
        return match?.[1];
      })
      .filter((target): target is string => Boolean(target))
      .filter((target) => !existsSync(join(__dirname, '..', target)));

    expect(missingTargets).toEqual([]);
  });
});

describe('run-perf', () => {
  test('passes one run flag followed by all benchmark filters', () => {
    const args = buildVitestArgs('/tmp/bench.json', [
      'test/perf/query.bench.ts',
      'test/perf/pool.bench.ts',
    ]);

    expect(args.filter((arg) => arg === '--run')).toHaveLength(1);
    expect(args.slice(-3)).toEqual([
      '--run',
      'test/perf/query.bench.ts',
      'test/perf/pool.bench.ts',
    ]);
  });

  test('parses benchmark output and filters separately', () => {
    expect(
      parseRunArgs([
        '--gha-output',
        'action-bench.json',
        'test/perf/query.bench.ts',
      ])
    ).toEqual({
      ghaOutput: 'action-bench.json',
      runFilters: ['test/perf/query.bench.ts'],
    });
  });
});

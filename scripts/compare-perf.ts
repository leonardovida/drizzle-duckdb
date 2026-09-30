#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import process from 'node:process';

export type ActionBenchRow = {
  name: string;
  unit?: string;
  value: number;
  range?: number;
};

export type LegacyPerfResult = {
  name: string;
  hz: number;
  rme?: number;
};

export type LegacyPerfFile = {
  meta?: Record<string, unknown>;
  results: LegacyPerfResult[];
};

export type NormalizedBenchRow = {
  name: string;
  opsPerSecond: number;
  relativeMargin: number;
};

export type ComparisonRow = {
  name: string;
  previous?: NormalizedBenchRow;
  next?: NormalizedBenchRow;
  percentChange?: number;
  isRegressionRisk: boolean;
};

export type CliArgs = {
  previousPath: string;
  nextPath: string;
  threshold: number;
  failOnRegression: boolean;
  allowNew: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeActionBenchRow(row: unknown): NormalizedBenchRow {
  if (
    !isRecord(row) ||
    typeof row.name !== 'string' ||
    typeof row.value !== 'number' ||
    (row.range !== undefined && typeof row.range !== 'number') ||
    (row.unit !== undefined && row.unit !== 'ops/s')
  ) {
    throw new Error('Invalid action-bench row');
  }

  return {
    name:
      row.name === 'array contains (builder with array rewrite)'
        ? 'array contains (builder with native operators)'
        : row.name,
    opsPerSecond: row.value,
    relativeMargin: typeof row.range === 'number' ? row.range : 0,
  };
}

function normalizeLegacyResult(row: unknown): NormalizedBenchRow {
  if (
    !isRecord(row) ||
    typeof row.name !== 'string' ||
    typeof row.hz !== 'number' ||
    (row.rme !== undefined && typeof row.rme !== 'number')
  ) {
    throw new Error('Invalid legacy perf row');
  }

  return {
    name: row.name,
    opsPerSecond: row.hz,
    relativeMargin: typeof row.rme === 'number' ? row.rme : 0,
  };
}

export function normalizePerfFile(input: unknown): NormalizedBenchRow[] {
  let rows: NormalizedBenchRow[];
  if (Array.isArray(input)) {
    rows = input.map(normalizeActionBenchRow);
  } else if (isRecord(input) && Array.isArray(input.results)) {
    rows = input.results.map(normalizeLegacyResult);
  } else {
    throw new Error(
      'Unsupported benchmark file format. Expected action-bench rows or a legacy { results: [...] } payload.'
    );
  }
  const names = new Set<string>();
  if (!rows.length) throw new Error('Benchmark file contains no measurements');
  for (const row of rows) {
    if (
      !row.name.trim() ||
      !Number.isFinite(row.opsPerSecond) ||
      row.opsPerSecond <= 0 ||
      !Number.isFinite(row.relativeMargin) ||
      row.relativeMargin < 0
    ) {
      throw new Error(
        `Invalid measurement for benchmark ${JSON.stringify(row.name)}`
      );
    }
    if (names.has(row.name))
      throw new Error(`Duplicate benchmark ${JSON.stringify(row.name)}`);
    names.add(row.name);
  }
  return rows;
}

export async function loadNormalizedFile(
  path: string
): Promise<NormalizedBenchRow[]> {
  const raw = await readFile(path, 'utf8');
  return normalizePerfFile(JSON.parse(raw));
}

export function percentChange(previous: number, next: number): number {
  if (previous === 0) {
    return 0;
  }

  return ((next - previous) / previous) * 100;
}

export function compareBenchmarks(
  previousRows: NormalizedBenchRow[],
  nextRows: NormalizedBenchRow[],
  threshold: number
): ComparisonRow[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 100)
    throw new Error('Threshold must be between 0 and 100');
  const previousMap = new Map(previousRows.map((row) => [row.name, row]));
  const nextMap = new Map(nextRows.map((row) => [row.name, row]));
  const names = [...new Set([...previousMap.keys(), ...nextMap.keys()])].sort();

  return names.map((name) => {
    const previous = previousMap.get(name);
    const next = nextMap.get(name);
    const change =
      previous && next
        ? percentChange(previous.opsPerSecond, next.opsPerSecond)
        : undefined;

    return {
      name,
      previous,
      next,
      percentChange: change,
      isRegressionRisk: typeof change === 'number' && change <= threshold * -1,
    };
  });
}

/** Gate only a drop whose reported uncertainty still exceeds the threshold. */
export function regressionFailures(
  rows: ComparisonRow[],
  threshold: number,
  allowNew = false
): string[] {
  return rows
    .filter((row) => {
      if (!row.next) return true;
      if (!row.previous) return !allowNew;
      const previousLower =
        row.previous.opsPerSecond *
        Math.max(0, 1 - row.previous.relativeMargin / 100);
      const nextUpper =
        row.next.opsPerSecond * (1 + row.next.relativeMargin / 100);
      return (
        row.isRegressionRisk &&
        nextUpper < previousLower * (1 - threshold / 100)
      );
    })
    .map((row) => row.name);
}

export function renderComparison(rows: ComparisonRow[]): string {
  return rows
    .map((row) => {
      if (!row.previous || !row.next) {
        return `${row.name}: missing in ${row.previous ? 'new' : 'old'} run`;
      }

      const delta = row.percentChange ?? 0;
      const trend = delta >= 0 ? 'faster' : 'slower';
      const risk = row.isRegressionRisk ? ' regression risk' : '';

      return `${row.name}: ${row.previous.opsPerSecond.toFixed(2)} -> ${row.next.opsPerSecond.toFixed(2)} ops/sec (${delta.toFixed(2)}% ${trend})${risk} (RME ${row.previous.relativeMargin.toFixed(2)}%, ${row.next.relativeMargin.toFixed(2)}%)`;
    })
    .join('\n');
}

export function parseArgs(argv: string[]): CliArgs {
  let threshold = Number(process.env.THRESHOLD ?? '5');
  let failOnRegression = false;
  let allowNew = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--fail-on-regression') {
      failOnRegression = true;
      continue;
    }
    if (arg === '--allow-new') {
      allowNew = true;
      continue;
    }

    if (arg === '--threshold') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --threshold');
      }
      threshold = Number(next);
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun run scripts/compare-perf.ts [--threshold <percent>] [--fail-on-regression] [--allow-new] <old.json> <new.json>'
      );
      process.exit(0);
    }

    if (arg?.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    positional.push(arg!);
  }

  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 100) {
    throw new Error('Threshold must be a non-negative number');
  }

  const [previousPath, nextPath] = positional;
  if (!previousPath || !nextPath || positional.length !== 2) {
    throw new Error(
      'Usage: bun run scripts/compare-perf.ts [--threshold <percent>] <old.json> <new.json>'
    );
  }

  return { previousPath, nextPath, threshold, failOnRegression, allowNew };
}

async function main(): Promise<void> {
  const { previousPath, nextPath, threshold, failOnRegression, allowNew } =
    parseArgs(process.argv.slice(2));
  const previousRows = await loadNormalizedFile(previousPath);
  const nextRows = await loadNormalizedFile(nextPath);
  const comparison = compareBenchmarks(previousRows, nextRows, threshold);

  console.log(renderComparison(comparison));
  if (failOnRegression) {
    const failures = regressionFailures(comparison, threshold, allowNew);
    if (failures.length)
      throw new Error(
        `Benchmark regression or missing measurement: ${failures.join(', ')}`
      );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

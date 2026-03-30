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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeActionBenchRow(row: unknown): NormalizedBenchRow {
  if (!isRecord(row) || typeof row.name !== 'string' || typeof row.value !== 'number') {
    throw new Error('Invalid action-bench row');
  }

  return {
    name: row.name,
    opsPerSecond: row.value,
    relativeMargin: typeof row.range === 'number' ? row.range : 0,
  };
}

function normalizeLegacyResult(row: unknown): NormalizedBenchRow {
  if (!isRecord(row) || typeof row.name !== 'string' || typeof row.hz !== 'number') {
    throw new Error('Invalid legacy perf row');
  }

  return {
    name: row.name,
    opsPerSecond: row.hz,
    relativeMargin: typeof row.rme === 'number' ? row.rme : 0,
  };
}

export function normalizePerfFile(input: unknown): NormalizedBenchRow[] {
  if (Array.isArray(input)) {
    return input.map((row) => normalizeActionBenchRow(row));
  }

  if (isRecord(input) && Array.isArray(input.results)) {
    return input.results.map((row) => normalizeLegacyResult(row));
  }

  throw new Error(
    'Unsupported benchmark file format. Expected action-bench rows or a legacy { results: [...] } payload.'
  );
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
      isRegressionRisk:
        typeof change === 'number' && change <= threshold * -1,
    };
  });
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

      return `${row.name}: ${row.previous.opsPerSecond.toFixed(2)} -> ${row.next.opsPerSecond.toFixed(2)} ops/sec (${delta.toFixed(2)}% ${trend})${risk}`;
    })
    .join('\n');
}

export function parseArgs(argv: string[]): CliArgs {
  let threshold = Number.parseFloat(process.env.THRESHOLD ?? '5');
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--threshold') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for --threshold');
      }
      threshold = Number.parseFloat(next);
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun run scripts/compare-perf.ts [--threshold <percent>] <old.json> <new.json>'
      );
      process.exit(0);
    }

    positional.push(arg);
  }

  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error('Threshold must be a non-negative number');
  }

  const [previousPath, nextPath] = positional;
  if (!previousPath || !nextPath) {
    throw new Error(
      'Usage: bun run scripts/compare-perf.ts [--threshold <percent>] <old.json> <new.json>'
    );
  }

  return { previousPath, nextPath, threshold };
}

async function main(): Promise<void> {
  const { previousPath, nextPath, threshold } = parseArgs(process.argv.slice(2));
  const previousRows = await loadNormalizedFile(previousPath);
  const nextRows = await loadNormalizedFile(nextPath);
  const comparison = compareBenchmarks(previousRows, nextRows, threshold);

  console.log(renderComparison(comparison));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

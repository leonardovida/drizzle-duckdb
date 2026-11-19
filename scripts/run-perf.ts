#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizePerfFile } from './compare-perf.ts';

type ActionBenchRow = {
  name: string;
  unit: 'ops/s';
  value: number;
  range: number;
};

type CliArgs = {
  ghaOutput?: string;
  runFilters: string[];
};

export function parseArgs(argv: string[]): CliArgs {
  const runFilters: string[] = [];
  let ghaOutput: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;

    if (arg === '--gha-output' || arg === '--ghaOutput') {
      ghaOutput = argv[i + 1];
      if (!ghaOutput || ghaOutput.startsWith('-'))
        throw new Error('Missing value for --gha-output');
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun run scripts/run-perf.ts [--gha-output <file>] [run filters...]'
      );
      console.log(
        'Example: bun run perf:run -- --gha-output action-bench.json'
      );
      process.exit(0);
    }

    runFilters.push(arg);
  }

  return { ghaOutput, runFilters };
}

/**
 * Reads benchmark tasks from the Vitest JSON reporter. The value is 1000 over
 * the mean latency in milliseconds, which is the `hz` that Vitest 4 reported.
 * tinybench's `throughput.mean` averages per-sample rates instead and runs
 * higher, so it would not compare with the recorded history.
 */
export function toActionRows(data: any): ActionBenchRow[] {
  const rows: ActionBenchRow[] = [];

  for (const file of data?.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      for (const benchmark of test.benchmarks ?? []) {
        for (const task of benchmark.tasks ?? []) {
          const mean = task?.latency?.mean;
          if (task?.fromStore || typeof mean !== 'number' || !(mean > 0)) {
            continue;
          }

          rows.push({
            name: task.name,
            unit: 'ops/s',
            value: 1000 / mean,
            range: task.latency.rme ?? 0,
          });
        }
      }
    }
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function writeJson(
  outPath: string,
  rows: ActionBenchRow[]
): Promise<void> {
  const dir = path.dirname(outPath);
  if (dir && dir !== '.') {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(outPath, JSON.stringify(rows, null, 2) + '\n', 'utf8');
}

export function buildVitestArgs(
  outputJson: string,
  runFilters: string[]
): string[] {
  const args = [
    'x',
    'vitest',
    'bench',
    '--pool=threads',
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${outputJson}`,
    '--run',
  ];

  args.push(...(runFilters.length ? runFilters : ['test/perf']));
  return args;
}

async function runVitest(
  outputJson: string,
  runFilters: string[]
): Promise<void> {
  const args = buildVitestArgs(outputJson, runFilters);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', args, { stdio: 'inherit' });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`vitest bench exited with code ${code}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const { ghaOutput, runFilters } = parseArgs(process.argv.slice(2));
  const tempJson = path.join(
    os.tmpdir(),
    `vitest-bench-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  await runVitest(tempJson, runFilters);

  const raw = await fs.readFile(tempJson, 'utf8');
  const rows = toActionRows(JSON.parse(raw));
  normalizePerfFile(rows);
  await fs.unlink(tempJson).catch(() => {});

  const outPath = ghaOutput ?? 'action-bench.json';
  await writeJson(outPath, rows);
  const packageVersion = async (name: string) => {
    const packageJson = await fs.readFile(
      new URL(`../node_modules/${name}/package.json`, import.meta.url),
      'utf8'
    );
    return (JSON.parse(packageJson) as { version: string }).version;
  };
  const metadata = {
    recordedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    // Vitest runs in Node workers. Bun's embedded Node version describes
    // this controller, not the process executing the measurements.
    runtime: JSON.parse(
      execFileSync('node', ['-p', 'JSON.stringify(process.versions)'], {
        encoding: 'utf8',
      })
    ) as Record<string, string>,
    controller: process.versions,
    workingTreeDirty:
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
      }).trim().length > 0,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    cpuCount: os.cpus().length,
    versions: {
      duckdb: await packageVersion('@duckdb/node-api'),
      drizzle: await packageVersion('drizzle-orm'),
      vitest: await packageVersion('vitest'),
    },
    dataset: {
      factRows: 100000,
      wideRows: 2000,
      arrayRows: 5000,
      streamRowsPerChunk: 10000,
    },
    uncertainty: 'range is the relative margin of error in percent',
    filters: runFilters,
  };
  await fs.writeFile(
    `${outPath}.meta.json`,
    JSON.stringify(metadata, null, 2) + '\n'
  );
  await fs.mkdir('perf-results', { recursive: true });
  await fs.writeFile(path.join('perf-results', `${Date.now()}-raw.json`), raw);

  console.log(`Wrote ${rows.length} benchmarks to ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

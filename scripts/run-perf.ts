#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

function parseArgs(argv: string[]): CliArgs {
  const runFilters: string[] = [];
  let ghaOutput: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--gha-output' || arg === '--ghaOutput') {
      ghaOutput = argv[i + 1];
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

function toActionRows(data: any): ActionBenchRow[] {
  const rows: ActionBenchRow[] = [];

  for (const file of data.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const bench of group.benchmarks ?? []) {
        if (bench?.hz == null) {
          continue;
        }

        rows.push({
          name: bench.name,
          unit: 'ops/s',
          value: bench.hz,
          range: bench.rme ?? 0,
        });
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

async function runVitest(
  outputJson: string,
  runFilters: string[]
): Promise<void> {
  const args = [
    'x',
    'vitest',
    'bench',
    '--pool=threads',
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--outputJson',
    outputJson,
  ];

  if (runFilters.length) {
    for (const filter of runFilters) {
      args.push('--run', filter);
    }
  } else {
    args.push('--run', 'test/perf');
  }

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
  await fs.unlink(tempJson).catch(() => {});

  const outPath = ghaOutput ?? 'action-bench.json';
  await writeJson(outPath, rows);

  console.log(`Wrote ${rows.length} benchmarks to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

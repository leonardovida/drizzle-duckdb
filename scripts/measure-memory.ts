#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DuckDBInstance } from '@duckdb/node-api';
import type * as Driver from '../src/driver.ts';
import { sql } from 'drizzle-orm';
import { bigint, doublePrecision, pgTable, text } from 'drizzle-orm/pg-core';

const packageName = '@duckdbfan/drizzle-duckdb';
const { drizzle } = (await import(packageName)) as typeof Driver;

const modes = ['native', 'raw', 'builder', 'columnar', 'stream'] as const;
type Mode = (typeof modes)[number];
const mode = process.argv[2] as Mode | undefined;
if (!mode) {
  // Separate processes prevent retained buffers from a previous path from
  // affecting the next path. Run after building, using Node 24 or newer.
  const results = modes.map(
    (mode) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ['--expose-gc', fileURLToPath(import.meta.url), mode],
          { encoding: 'utf8' }
        )
      ) as Record<string, unknown>
  );
  const artifact = {
    runtime: process.versions,
    cpu: cpus()[0]?.model,
    rows: 100000,
    note: 'RSS sampled every 5 ms and immediately after reads. Observed peaks are lower bounds, not allocated-byte totals.',
    results,
  };
  mkdirSync('perf-results', { recursive: true });
  writeFileSync(
    'perf-results/memory.json',
    JSON.stringify(artifact, null, 2) + '\n'
  );
  console.log(JSON.stringify(artifact, null, 2));
} else {
  if (!modes.includes(mode)) throw new Error(`Unknown memory mode ${mode}`);
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);
  const fact = pgTable('memory_fact', {
    id: bigint('id', { mode: 'bigint' }),
    value: doublePrecision('value'),
    payload: text('payload'),
  });
  try {
    await connection.run(
      "create table memory_fact as select i as id, i::double as value, repeat('payload-',8) as payload from range(100000) t(i)"
    );
    globalThis.gc?.();
    const baseline = process.memoryUsage();
    let peakRss = baseline.rss;
    const observe = () => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    };
    const timer = setInterval(observe, 5);
    const start = performance.now();
    let count = 0;
    let checksum = 0;
    const query = sql`select * from memory_fact`;
    if (mode === 'native') {
      const rows = await (
        await connection.run('select * from memory_fact')
      ).getRowsJS();
      observe();
      count = rows.length;
      checksum = rows.reduce((sum, row) => sum + Number(row[0]), 0);
    } else if (mode === 'columnar') {
      const columns = (await db.executeArrow(query)) as { id: bigint[] };
      observe();
      count = columns.id.length;
      checksum = columns.id.reduce((sum, id) => sum + Number(id), 0);
    } else if (mode === 'stream') {
      for await (const rows of db.executeBatchesRaw(query, {
        rowsPerChunk: 10000,
      })) {
        observe();
        count += rows.rows.length;
        checksum += rows.rows.reduce((sum, row) => sum + Number(row[0]), 0);
      }
    } else {
      const rows =
        mode === 'builder'
          ? await db.select().from(fact)
          : await db.execute(query);
      observe();
      count = rows.length;
      checksum = rows.reduce((sum, row) => sum + Number(row.id), 0);
    }
    clearInterval(timer);
    if (count !== 100000 || checksum !== 4_999_950_000)
      throw new Error('Memory benchmark checksum mismatch');
    console.log(
      JSON.stringify({
        mode,
        count,
        checksum,
        ms: performance.now() - start,
        baselineRss: baseline.rss,
        observedPeakRss: peakRss,
        rssIncrease: peakRss - baseline.rss,
      })
    );
  } finally {
    await db.close();
    instance.closeSync();
  }
}

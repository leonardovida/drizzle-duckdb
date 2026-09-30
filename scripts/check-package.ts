#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercise the published tarball from outside this repository so self-imports
// and local source paths cannot conceal missing exports or declarations.
const directory = await mkdtemp(
  path.join(tmpdir(), 'drizzle-duckdb-consumer-')
);
try {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
    })
  ) as { filename: string }[];
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@duckdbfan/drizzle-duckdb': `file:${path.join(directory, packed[0]!.filename)}`,
        '@duckdb/node-api':
          process.env.CONSUMER_DUCKDB_VERSION ??
          manifest.devDependencies['@duckdb/node-api'],
        'drizzle-orm':
          process.env.CONSUMER_DRIZZLE_VERSION ??
          manifest.devDependencies['drizzle-orm'],
      },
    })
  );
  execFileSync('bun', ['install'], {
    cwd: directory,
    stdio: 'inherit',
    timeout: 90_000,
  });
  const consumer = `import { drizzle, getPreparedStatementCacheStats } from '@duckdbfan/drizzle-duckdb';
import { duckDbList, duckDbTimestamp } from '@duckdbfan/drizzle-duckdb/helpers';
import { sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
const table = pgTable('consumer_items', { id: integer('id'), values: duckDbList<number>('items', 'INTEGER'), createdAt: duckDbTimestamp('created_at') });
const db = await drizzle(':memory:', { pool: false, decimalMode: 'string', prepareCache: true });
try {
  const rows = await db.execute(sql\`select 42::integer as answer\`);
  if (rows[0]?.answer !== 42) throw new Error('Packed consumer returned incorrect result');
  await db.execute(sql\`create table consumer_items(id integer, items integer[], created_at timestamp)\`);
  await db.insert(table).values({ id: 1, values: [1, 2], createdAt: new Date('2024-01-01T00:00:00Z') });
  const [row] = await db.select().from(table);
  if (row?.values?.length !== 2 || !(row.createdAt instanceof Date)) throw new Error('Packed consumer decoding failed');
} finally { await db.close(); }
`;
  await writeFile(
    path.join(directory, 'consumer.mjs'),
    consumer.replace('duckDbList<number>', 'duckDbList')
  );
  await writeFile(path.join(directory, 'consumer.ts'), consumer);
  execFileSync('node', ['consumer.mjs'], { cwd: directory, stdio: 'inherit' });
  execFileSync(
    path.resolve('node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      'consumer.ts',
    ],
    { cwd: directory, stdio: 'inherit' }
  );
  console.log('Packed consumer runtime and type checks passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}

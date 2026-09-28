/**
 * DuckLake Local Catalog Example
 *
 * This example shows how to attach a local DuckLake catalog and write data.
 * The catalog and data files go into a fresh directory under the OS temp
 * directory, which is removed when the script finishes.
 *
 * Run with:
 *   bun run example/ducklake-local.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from '../src/index.ts';

const users = pgTable('ducklake_users', {
  id: integer('id'),
  name: text('name').notNull(),
});

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'drizzle-ducklake-'));
  const db = await drizzle(':memory:', {
    ducklake: {
      catalog: join(directory, 'ducklake.duckdb'),
      install: true,
      load: true,
      attachOptions: {
        dataPath: join(directory, 'ducklake-data'),
        createIfNotExists: true,
      },
    },
  });

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ducklake_users (
        id INTEGER,
        name TEXT NOT NULL
      )
    `);

    await db.insert(users).values([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);

    const rows = await db.select().from(users).orderBy(users.id);
    console.table(rows);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

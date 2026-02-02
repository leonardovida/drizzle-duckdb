/**
 * DuckLake Local Catalog Example
 *
 * This example shows how to attach a local DuckLake catalog and write data.
 *
 * Run with:
 *   bun run example/ducklake-local.ts
 */

import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from '../src/index.ts';

const users = pgTable('ducklake_users', {
  id: integer('id'),
  name: text('name').notNull(),
});

async function main() {
  const db = await drizzle(':memory:', {
    ducklake: {
      catalog: './ducklake.duckdb',
      install: true,
      load: true,
      attachOptions: {
        dataPath: './ducklake-data',
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
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

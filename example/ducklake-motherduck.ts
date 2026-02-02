/**
 * DuckLake MotherDuck Example
 *
 * This example attaches a DuckLake catalog hosted on MotherDuck.
 *
 * Prerequisites:
 * - Set MOTHERDUCK_TOKEN
 * - Create a DuckLake database in MotherDuck, for example:
 *   CREATE DATABASE my_lake TYPE DUCKLAKE;
 * - Set DUCKLAKE_MOTHERDUCK_DB to the database name (for example: my_lake)
 *
 * Run with:
 *   MOTHERDUCK_TOKEN=token DUCKLAKE_MOTHERDUCK_DB=my_lake bun run example/ducklake-motherduck.ts
 */

import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from '../src/index.ts';

const users = pgTable('ducklake_users', {
  id: integer('id'),
  name: text('name').notNull(),
});

async function main() {
  const motherduckToken = process.env.MOTHERDUCK_TOKEN;
  const ducklakeDb = process.env.DUCKLAKE_MOTHERDUCK_DB;

  if (!motherduckToken || !ducklakeDb) {
    console.error(
      'Set MOTHERDUCK_TOKEN and DUCKLAKE_MOTHERDUCK_DB before running this example.'
    );
    process.exit(1);
  }

  const db = await drizzle({
    connection: {
      path: 'md:',
      options: { motherduck_token: motherduckToken },
    },
    ducklake: {
      catalog: `md:__ducklake_metadata_${ducklakeDb}`,
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
      { id: 1, name: 'Quinn' },
      { id: 2, name: 'Riley' },
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

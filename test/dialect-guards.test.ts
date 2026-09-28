import { eq, sql } from 'drizzle-orm';
import { integer, json, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { DuckDBDialect } from '../src/dialect.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import { migrate } from '../src/migrator.ts';

let db: DuckDBDatabase;

beforeAll(async () => {
  db = await drizzle(':memory:');
});

afterAll(async () => {
  await db?.close();
});

test('Pg json and jsonb params throw the DuckDB guidance error', async () => {
  const docs = pgTable('pg_json_docs', {
    id: integer('id'),
    data: json('data'),
    meta: jsonb('meta'),
  });
  await db.execute(
    sql`create table pg_json_docs (id integer, data json, meta json)`
  );

  await expect(
    db.insert(docs).values({ id: 1, data: { a: 1 } })
  ).rejects.toThrow(
    "Pg JSON/JSONB columns are not supported in DuckDB. Replace them with duckDbJson() to use DuckDB's native JSON type."
  );
  await expect(
    db
      .select()
      .from(docs)
      .where(eq(docs.meta, { a: 1 }))
  ).rejects.toThrow(/Replace them with duckDbJson\(\)/);
  await expect(db.select({ id: docs.id }).from(docs)).resolves.toEqual([]);
});

test('identifiers with embedded double quotes are escaped', async () => {
  expect(new DuckDBDialect().escapeName('we"ird')).toBe('"we""ird"');

  const weird = pgTable('quote"table', {
    id: integer('id"col'),
    label: text('label'),
  });
  await db.execute(
    sql`create table ${weird} (${sql.identifier('id"col')} integer, label text)`
  );
  await db.insert(weird).values({ id: 1, label: 'one' });

  expect(await db.select().from(weird).where(eq(weird.id, 1))).toEqual([
    { id: 1, label: 'one' },
  ]);
});

test('migrations accept table names containing single quotes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'drizzle-duckdb-migrations-'));
  const migrationDb = await drizzle(':memory:');
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(
      join(folder, '0000_init.sql'),
      'create table quoted_migration_target (id integer);'
    );
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 1700000000000,
            tag: '0000_init',
            breakpoints: true,
          },
        ],
      })
    );

    await migrate(migrationDb, {
      migrationsFolder: folder,
      migrationsTable: "o'brien",
    });

    await expect(
      migrationDb.execute(
        sql`select count(*)::int as total from ${sql.identifier('drizzle')}.${sql.identifier("o'brien")}`
      )
    ).resolves.toEqual([{ total: 1 }]);
  } finally {
    await migrationDb.close();
    await rm(folder, { recursive: true, force: true });
  }
});

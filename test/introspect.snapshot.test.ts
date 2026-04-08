import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { drizzle } from '../src/index';
import { introspect } from '../src/introspect';
import { afterAll, beforeAll, expect, test } from 'vitest';

let connection: DuckDBConnection;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();

  const db = drizzle(connection);

  await db.execute(sql`create schema if not exists snap`);
  await db.execute(sql`
    create table snap.products (
      id integer primary key,
      visits bigint not null,
      hits ubigint,
      price decimal(12, 2),
      payload struct(name text, values integer[]),
      extras map(varchar, integer[]),
      tags text[],
      labels varchar[],
      fixed integer[3],
      meta json not null,
      created_at timestamp with time zone default current_timestamp,
      duration interval
    )
  `);
});

afterAll(() => {
  connection?.closeSync();
});

test('introspection snapshot covers DuckDB-specific types', async () => {
  const db = drizzle(connection);

  const result = await introspect(db, {
    schemas: ['snap'],
    importBasePath: '../src/index.ts',
  });

  const schemaTs = result.files.schemaTs;

  const fragments = [
    `bigint("visits", { mode: 'number' }).notNull()`,
    `bigint("hits", { mode: 'number' })`,
    `numeric("price", { precision: 12, scale: 2 })`,
    `duckDbStruct("payload", { "name": "VARCHAR", "values": "INTEGER[]" })`,
    `duckDbMap("extras", "INTEGER[]")`,
    `duckDbList("tags", "VARCHAR")`,
    `duckDbList("labels", "VARCHAR")`,
    `duckDbArray("fixed", "INTEGER", 3)`,
    `duckDbJson("meta").notNull()`,
    `duckDbTimestamp("created_at", { withTimezone: true })`,
    `duckDbInterval("duration")`,
  ];

  for (const fragment of fragments) {
    expect(schemaTs).toContain(fragment);
  }
});

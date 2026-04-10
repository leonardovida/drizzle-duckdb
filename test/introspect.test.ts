import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { drizzle } from '../src/index';
import { introspect } from '../src/introspect';
import { afterAll, beforeAll, expect, test } from 'vitest';

interface Context {
  connection: DuckDBConnection;
}

const ctx: Context = {} as Context;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);

  ctx.connection = connection;

  await db.execute(sql`create schema if not exists introspect`);
  await db.execute(sql`create sequence if not exists introspect.items_seq`);
  await db.execute(
    sql`create type introspect.item_status as enum ('pending', 'done')`
  );

  await db.execute(sql`
    create table introspect.parents (
      id integer primary key,
      name text not null
    )
  `);

  await db.execute(sql`
    create table introspect.items (
      id integer primary key default nextval('introspect.items_seq'),
      name text not null,
      visits bigint not null,
      precise_time time_ns,
      wake_at time with time zone,
      tags integer[],
      fixed integer[2],
      payload struct("name" varchar, "values" integer[]),
      extras map(varchar, integer[]),
      json_col json not null,
      duration interval,
      price decimal,
      status introspect.item_status,
      happened_ns timestamp_ns,
      happened_ms timestamp_ms,
      happened_s timestamp_s,
      created_at timestamp with time zone default current_timestamp,
      parent_id integer references introspect.parents(id),
      unique_col text unique,
      unique_pair text,
      unique(unique_pair, parent_id)
    )
  `);
});

afterAll(() => {
  ctx.connection?.closeSync();
});

test('introspects duckdb catalog and maps duckdb-specific types', async () => {
  const db = drizzle(ctx.connection);

  const result = await introspect(db, {
    schemas: ['introspect'],
    importBasePath: '../src/index.ts',
  });

  const schemaTs = result.files.schemaTs;

  expect(schemaTs).toContain(`duckDbJson("json_col")`);
  expect(schemaTs).toContain(`duckDbStruct("payload"`);
  expect(schemaTs).toContain(`duckDbMap("extras"`);
  expect(schemaTs).toContain(`duckDbList("tags"`);
  expect(schemaTs).toContain(`duckDbArray("fixed"`);
  expect(schemaTs).toContain(`duckDbInterval("duration"`);
  expect(schemaTs).toContain(`numeric("price", { precision: 18, scale: 3 })`);
  expect(schemaTs).toContain(
    `duckDbTime("precise_time", { duckDbType: 'TIME_NS' })`
  );
  expect(schemaTs).toContain(`duckDbTime("wake_at", { withTimezone: true })`);
  expect(schemaTs).toContain(`/* ENUM ('pending', 'done') */`);
  expect(schemaTs).toContain(`bigint("visits", { mode: 'number' })`);
  expect(schemaTs).toContain(
    `duckDbTimestamp("happened_ns", { duckDbType: "TIMESTAMP_NS" })`
  );
  expect(schemaTs).toContain(
    `duckDbTimestamp("happened_ms", { duckDbType: "TIMESTAMP_MS" })`
  );
  expect(schemaTs).toContain(
    `duckDbTimestamp("happened_s", { duckDbType: "TIMESTAMP_S" })`
  );
  expect(schemaTs).toContain(
    `duckDbTimestamp("created_at", { withTimezone: true })`
  );
  expect(schemaTs).toContain(`primaryKey({ columns: [t.id]`);
  expect(schemaTs).toContain(
    `foreignKey({ columns: [t.parentId], foreignColumns: [parents.id]`
  );
  expect(schemaTs).toContain(`.on(t.uniquePair, t.parentId)`);

  const itemsTable = result.files.metaJson.find(
    (table) => table.schema === 'introspect' && table.name === 'items'
  );

  expect(itemsTable?.columns.length).toBeGreaterThanOrEqual(5);
  expect(itemsTable?.constraints.some((c) => c.type === 'FOREIGN KEY')).toBe(
    true
  );
  expect(itemsTable?.constraints.some((c) => c.type === 'UNIQUE')).toBe(true);
});

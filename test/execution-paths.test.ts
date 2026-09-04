import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import * as clientModule from '../src/client.ts';
import { drizzle } from '../src/driver.ts';
import type { DuckDBDrizzleConfig } from '../src/driver.ts';

const sampleTable = pgTable('sample_exec_paths', {
  id: integer('id').primaryKey(),
  val: text('val'),
});

let instance: DuckDBInstance;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
});

afterAll(async () => {
  instance.closeSync?.();
});

async function setupDb(config?: DuckDBDrizzleConfig) {
  const connection = await instance.connect();
  const db = drizzle(connection, config);
  await db.execute(
    sql`create table if not exists sample_exec_paths (id integer, val text);`
  );
  await db.execute(sql`delete from sample_exec_paths;`);
  await db.execute(
    sql`insert into sample_exec_paths values (1, 'a'), (2, 'b'), (3, 'c');`
  );
  return { connection, db };
}

test('projections use array execution path', async () => {
  const { connection, db } = await setupDb();
  const spy = vi.spyOn(clientModule, 'executeArraysOnClient');

  const rows = await db
    .select({ id: sampleTable.id, val: sampleTable.val })
    .from(sampleTable)
    .where(eq(sampleTable.id, 1));

  expect(rows).toEqual([{ id: 1, val: 'a' }]);
  expect(spy).toHaveBeenCalled();

  spy.mockRestore();
  await db.close();
});

test('executeBatchesRaw streams array chunks', async () => {
  const { connection, db } = await setupDb();
  const seen: Array<{ columns: string[]; rows: unknown[][] }> = [];

  for await (const chunk of db.executeBatchesRaw(
    sql`select id, val from ${sampleTable} order by id`,
    { rowsPerChunk: 2 }
  )) {
    seen.push(chunk);
  }

  expect(seen.length).toBeGreaterThan(0);
  const flat = seen.flatMap((c) => c.rows);
  expect(flat.length).toBe(3);
  expect(seen[0]?.columns).toEqual(['id', 'val']);

  await db.close();
});

test('prepare cache reuses prepared statements', async () => {
  const { connection, db } = await setupDb({ prepareCache: true });
  const prepareSpy = vi.spyOn(connection, 'prepare');

  const prepared = db
    .select({ id: sampleTable.id })
    .from(sampleTable)
    .where(eq(sampleTable.id, sql.placeholder('pid')))
    .prepare('cached_select');

  const first = await prepared.execute({ pid: 2 });
  const second = await prepared.execute({ pid: 3 });

  expect(first[0]?.id).toBe(2);
  expect(second[0]?.id).toBe(3);
  expect(prepareSpy.mock.calls.length).toBe(1);

  prepareSpy.mockRestore();
  await db.close();
});

test('prepare cache keeps concurrent parameter bindings isolated', async () => {
  const { connection, db } = await setupDb({ prepareCache: true });
  const prepareSpy = vi.spyOn(connection, 'prepare');

  const prepared = db
    .select({ id: sampleTable.id })
    .from(sampleTable)
    .where(eq(sampleTable.id, sql.placeholder('pid')))
    .prepare('concurrent_cached_select');

  await prepared.execute({ pid: -1 });
  const ids = Array.from({ length: 32 }, (_, index) => (index % 3) + 1);
  const rows = await Promise.all(
    ids.map((id) => prepared.execute({ pid: id }))
  );

  expect(rows).toEqual(ids.map((id) => [{ id }]));
  expect(prepareSpy.mock.calls.length).toBe(1);

  prepareSpy.mockRestore();
  await db.close();
});

test('prepare cache evicts the least recently used statement', async () => {
  const { connection, db } = await setupDb({ prepareCache: 1 });
  const prepareSpy = vi.spyOn(connection, 'prepare');

  const selectById = db
    .select({ id: sampleTable.id })
    .from(sampleTable)
    .where(eq(sampleTable.id, sql.placeholder('pid')))
    .prepare('cached_select_by_id');

  const selectByValue = db
    .select({ val: sampleTable.val })
    .from(sampleTable)
    .where(eq(sampleTable.val, sql.placeholder('pval')))
    .prepare('cached_select_by_value');

  expect(await selectById.execute({ pid: 1 })).toEqual([{ id: 1 }]);
  expect(await selectByValue.execute({ pval: 'b' })).toEqual([{ val: 'b' }]);
  expect(await selectById.execute({ pid: 3 })).toEqual([{ id: 3 }]);
  expect(prepareSpy.mock.calls.length).toBe(3);

  prepareSpy.mockRestore();
  await db.close();
});

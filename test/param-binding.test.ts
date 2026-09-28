import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
  integer,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  drizzle,
  duckDbArray,
  duckDbList,
  duckDbMap,
  wrapMap,
  type DuckDBDatabase,
} from '../src/index.ts';

const lists = pgTable('binding_lists', {
  id: integer('id'),
  ints: integer('ints').array(),
  names: text('names').array(),
  l: duckDbList<number>('l', 'INTEGER'),
  a: duckDbArray<number>('a', 'INTEGER', 3),
  ds: doublePrecision('ds').array(),
  bigs: bigint('bigs', { mode: 'number' }).array(),
  d: doublePrecision('d'),
});

const tzValues = pgTable('binding_tz', {
  id: integer('id'),
  tl: duckDbList<Date>('tl', 'TIMESTAMPTZ'),
  tm: duckDbMap<Record<string, Date>>('tm', 'TIMESTAMPTZ'),
});

describe.each([
  { name: 'run', prepareCache: undefined },
  { name: 'prepared statement cache', prepareCache: true as const },
])('parameter binding ($name)', ({ prepareCache }) => {
  let instance: DuckDBInstance;
  let db: DuckDBDatabase;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect(), { prepareCache });
    await db.execute(sql`
      create table binding_lists (
        id integer, ints integer[], names text[], l integer[], a integer[3],
        ds double[], bigs bigint[], d double
      )
    `);
    await db.execute(
      sql`create table binding_tz (id integer, tl timestamptz[], tm map(varchar, timestamptz))`
    );
  });

  afterAll(async () => {
    await db.close();
    instance.closeSync();
  });

  test('lists whose first item is null keep their other items', async () => {
    await db.insert(lists).values({
      id: 1,
      ints: [null as unknown as number, 7, 8],
      names: [null as unknown as string, 'a'],
      l: [null as unknown as number, 7, 8],
      a: [null as unknown as number, 7, 8],
    });

    const [row] = await db
      .select({ ints: lists.ints, names: lists.names, l: lists.l, a: lists.a })
      .from(lists)
      .where(sql`${lists.id} = 1`);

    expect(row).toEqual({
      ints: [null, 7, 8],
      names: [null, 'a'],
      l: [null, 7, 8],
      a: [null, 7, 8],
    });
  });

  test('lists mixing integers and fractions or large integers bind', async () => {
    await db.insert(lists).values({
      id: 2,
      ds: [1, 2.5],
      bigs: [1, 3_000_000_000],
    });

    const [row] = await db
      .select({ ds: lists.ds, bigs: lists.bigs })
      .from(lists)
      .where(sql`${lists.id} = 2`);

    expect(row).toEqual({ ds: [1, 2.5], bigs: [1, 3_000_000_000] });
  });

  test('nested lists and map values infer from every item', async () => {
    const [row] = await db.execute<{ ll: unknown; t: string; m: unknown }>(
      sql`select
        ${sql.param([[null, 1], null, [2.5]])} as ll,
        typeof(${sql.param([[null, 1], null, [2.5]])}) as t,
        ${sql.param(wrapMap({ a: null, b: 5 }, 'INTEGER'))}::map(varchar, integer) as m`
    );

    expect(row?.ll).toEqual([[null, 1], null, [2.5]]);
    expect(row?.t).toBe('DOUBLE[][]');
    expect(row?.m).toEqual([
      { key: 'a', value: null },
      { key: 'b', value: 5 },
    ]);
  });

  test('integral numbers beyond int64 bind as DOUBLE', async () => {
    await db.insert(lists).values({ id: 3, d: 1e20 });

    const [row] = await db
      .select({ d: lists.d })
      .from(lists)
      .where(sql`${lists.id} = 3`);
    expect(row?.d).toBe(1e20);

    const [raw] = await db.execute<{ v: number; t: string }>(
      sql`select ${1e20} as v, typeof(${2 ** 60}) as t`
    );
    expect(raw).toEqual({ v: 1e20, t: 'DOUBLE' });
  });

  test('explicit types reach streams and executeArrow', async () => {
    // sql.param keeps the array one parameter instead of a tuple.
    const batches: unknown[] = [];
    for await (const batch of db.executeBatches(
      sql`select ${sql.param([null, 7, 8])}::integer[] as l`
    )) {
      batches.push(...batch);
    }
    expect(batches).toEqual([{ l: [null, 7, 8] }]);

    expect(
      await db.executeArrow(
        sql`select ${sql.param([null, 1, 2.5])}::double[] as l`
      )
    ).toEqual({ l: [[null, 1, 2.5]] });
  });

  test('Dates in TIMESTAMPTZ lists and maps keep their instant', async () => {
    await db.execute(sql`SET TimeZone = 'America/New_York'`);
    try {
      const instant = new Date('2024-01-01T00:00:00Z');
      await db.insert(tzValues).values({
        id: 1,
        tl: [instant],
        tm: { k: instant },
      });

      const [row] = await db.execute<{ list_ok: boolean; map_ok: boolean }>(
        sql`
          select
            tl[1] = '2024-01-01T00:00:00Z'::timestamptz as list_ok,
            tm['k'] = '2024-01-01T00:00:00Z'::timestamptz as map_ok
          from binding_tz where id = 1
        `
      );
      expect(row).toEqual({ list_ok: true, map_ok: true });

      // A bare Date param still binds as a naive UTC TIMESTAMP.
      const [bare] = await db.execute<{ s: string; t: string }>(
        sql`select ${instant}::varchar as s, typeof(${instant}) as t`
      );
      expect(bare).toEqual({ s: '2024-01-01 00:00:00', t: 'TIMESTAMP' });
    } finally {
      await db.execute(sql`RESET TimeZone`);
    }
  });

  test('Buffer and Uint8Array params bind as BLOB', async () => {
    const [row] = await db.execute<{ b: Uint8Array; t: string; u: string }>(
      sql`select ${Buffer.from([1, 2])} as b, typeof(${Buffer.from([1])}) as t, typeof(${new Uint8Array([3])}) as u`
    );

    expect(row?.t).toBe('BLOB');
    expect(row?.u).toBe('BLOB');
    expect(Array.from(row?.b ?? [])).toEqual([1, 2]);
  });

  test('an invalid Date param throws a clear error', async () => {
    await expect(
      db.execute(sql`select ${new Date('not a date')} as x`)
    ).rejects.toThrow(/Invalid Date/);
  });
});

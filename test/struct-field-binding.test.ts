import { DuckDBInstance, structValue } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  drizzle,
  wrapList,
  wrapStruct,
  type DuckDBDatabase,
} from '../src/index.ts';

function ownEntries<T>(entries: [string, T][]): Record<string, T> {
  return Object.fromEntries(entries);
}

describe.each([
  { name: 'run', prepareCache: undefined },
  { name: 'prepared statement cache', prepareCache: true as const },
])('STRUCT field binding ($name)', ({ prepareCache }) => {
  let instance: DuckDBInstance;
  let db: DuckDBDatabase;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect(), { prepareCache });
  });

  afterAll(async () => {
    await db.close();
    instance.closeSync();
  });

  test('preserves a scalar __proto__ field as stored data', async () => {
    const value = wrapStruct(
      ownEntries<unknown>([
        ['__proto__', 42],
        ['normal', 7],
      ])
    );
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual(
      ownEntries([
        ['__proto__', 42],
        ['normal', 7],
      ])
    );
  });

  test('persists a __proto__ field in a typed STRUCT column', async () => {
    await db.execute(sql`create table bound_structs (
      value struct("__proto__" integer, normal integer)
    )`);
    const value = wrapStruct(
      ownEntries([
        ['__proto__', 42],
        ['normal', 7],
      ])
    );
    await db.execute(
      sql`insert into bound_structs values (${sql.param(value)})`
    );

    expect(
      await db.execute(sql`select value."__proto__" as field, value.normal as normal
        from bound_structs`)
    ).toEqual([{ field: 42, normal: 7 }]);
  });

  test('ignores inherited schema hints', async () => {
    const value = wrapStruct(
      ownEntries([
        ['__proto__', 42],
        ['constructor', 7],
      ]),
      {}
    );
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual(
      ownEntries([
        ['__proto__', 42],
        ['constructor', 7],
      ])
    );
  });

  test('infers native STRUCT fields from own entries only', async () => {
    const entries = Object.assign(Object.create({ inherited: 9 }), {
      normal: 7,
    });
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(structValue(entries))})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual({ normal: 7 });
  });

  test('preserves an object-valued __proto__ field without adding fields', async () => {
    const value = wrapStruct(
      ownEntries<unknown>([
        ['__proto__', wrapStruct({ nested: 9 })],
        ['normal', 7],
      ])
    );
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual(
      ownEntries<unknown>([
        ['__proto__', { nested: 9 }],
        ['normal', 7],
      ])
    );
  });

  test('keeps constructor and prototype fields as ordinary data', async () => {
    const value = wrapStruct({ constructor: 11, prototype: 13, normal: 7 });
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual({
      constructor: 11,
      prototype: 13,
      normal: 7,
    });
  });

  test('preserves __proto__ with an explicit schema hint', async () => {
    const value = wrapStruct(
      ownEntries<unknown>([
        ['__proto__', 3_000_000_000],
        ['normal', 7],
      ]),
      ownEntries([
        ['__proto__', 'BIGINT'],
        ['normal', 'INTEGER'],
      ])
    );
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual(
      ownEntries([
        ['__proto__', 3_000_000_000],
        ['normal', 7],
      ])
    );
  });

  test('preserves fields in nested STRUCT wrappers', async () => {
    const value = wrapStruct({
      payload: wrapStruct(
        ownEntries([
          ['__proto__', 42],
          ['normal', 7],
        ])
      ),
    });
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual({
      payload: ownEntries([
        ['__proto__', 42],
        ['normal', 7],
      ]),
    });
  });

  test('preserves fields when list item types widen', async () => {
    // The first item also needs number-to-bigint alignment. The second
    // widens the inferred STRUCT type, exercising all binding rebuilds.
    const value = wrapList([
      wrapStruct(
        ownEntries([
          ['__proto__', 1],
          ['normal', 2],
        ])
      ),
      wrapStruct(
        ownEntries([
          ['__proto__', 3_000_000_000],
          ['normal', 2.5],
        ])
      ),
    ]);
    const [row] = await db.execute<{ value: string }>(
      sql`select to_json(${sql.param(value)})::varchar as value`
    );

    expect(JSON.parse(row!.value)).toEqual([
      ownEntries([
        ['__proto__', 1],
        ['normal', 2],
      ]),
      ownEntries([
        ['__proto__', 3_000_000_000],
        ['normal', 2.5],
      ]),
    ]);
  });
});

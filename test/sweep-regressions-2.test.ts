import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  duckDbArrayContains,
  duckDbArrayOverlaps,
  duckDbDate,
  duckDbJson,
  duckDbList,
  duckDbMap,
  duckDbStruct,
  duckDbTimestamp,
  duckDbUnion,
} from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import { wrapList } from '../src/value-wrappers.ts';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

describe('column literals', () => {
  let db: DuckDBDatabase;
  const values = pgTable('sweep2_values', {
    id: integer('id'),
    maps: duckDbList<Record<string, string>>('maps', 'MAP(VARCHAR, VARCHAR)'),
    nested: duckDbMap<Record<string, Record<string, number>>>(
      'nested',
      'MAP(VARCHAR, INTEGER)',
      { mode: 'object' }
    ),
    struct: duckDbStruct<{ m: Record<string, number>; d: number }>('struct', {
      m: 'MAP(VARCHAR, INTEGER)',
      d: 'DOUBLE',
    }),
    doc: duckDbJson('doc'),
    ids: duckDbList<string>('ids', 'UUID'),
    idLists: duckDbList<string[]>('id_lists', 'UUID[]'),
    day: duckDbDate('day'),
    byDay: duckDbMap<Record<string, number>>('by_day', 'INTEGER', {
      mode: 'object',
      keyType: 'DATE',
    }),
  });

  beforeAll(async () => {
    db = await drizzle(':memory:', { pool: false });
    await db.execute(sql`
      create table sweep2_values (
        id integer,
        maps MAP(VARCHAR, VARCHAR)[],
        nested MAP(VARCHAR, MAP(VARCHAR, INTEGER)),
        struct STRUCT(m MAP(VARCHAR, INTEGER), d DOUBLE),
        doc JSON,
        ids UUID[],
        id_lists UUID[][],
        day DATE,
        by_day MAP(DATE, INTEGER)
      )
    `);
    await db.insert(values).values({
      id: 1,
      maps: [{ env: 'prod' }, { team: 'core' }, {}],
      nested: { x: { a: 1 }, y: { b: 2 }, z: {} },
      struct: { m: {}, d: -0 },
      doc: { queryChunks: ['x'], a: 1 },
      ids: [uuid],
      idLists: [[uuid], []],
      day: '10000-01-01',
      byDay: { '2024-01-02': 1 },
    });
    await db.execute(
      sql`insert into sweep2_values (id, day) values (2, DATE '0002-01-01 (BC)')`
    );
  });
  afterAll(async () => {
    await db.close();
  });

  test('maps inside lists and maps keep only their own keys', async () => {
    const [row] = await db
      .select()
      .from(values)
      .where(sql`${values.id} = 1`);
    expect(row!.maps).toEqual([
      [{ key: 'env', value: 'prod' }],
      [{ key: 'team', value: 'core' }],
      [],
    ]);
    expect(row!.nested).toEqual({
      x: [{ key: 'a', value: 1 }],
      y: [{ key: 'b', value: 2 }],
      z: [],
    });
    expect(row!.struct).toEqual({ m: [], d: -0 });
    expect(Object.is(row!.struct!.d, -0)).toBe(true);
    expect(row!.idLists).toEqual([[uuid], []]);
  });

  test('JSON documents with a queryChunks key stay data', async () => {
    const [row] = await db
      .select({ doc: values.doc })
      .from(values)
      .where(sql`${values.id} = 1`);
    expect(row!.doc).toEqual({ queryChunks: ['x'], a: 1 });
  });

  test('list predicates cast string values to the element type', async () => {
    for (const predicate of [duckDbArrayContains, duckDbArrayOverlaps]) {
      expect(
        await db
          .select({ id: values.id })
          .from(values)
          .where(predicate(values.ids, [uuid]))
      ).toEqual([{ id: 1 }]);
    }
  });

  test('dates outside years 1 to 9999 read as DuckDB text', async () => {
    const rows = await db
      .select({ day: values.day })
      .from(values)
      .orderBy(values.id);
    expect(rows).toEqual([{ day: '10000-01-01' }, { day: '0002-01-01 (BC)' }]);
  });

  test('object-mode MAP date keys do not depend on the host time zone', async () => {
    const [row] = await db
      .select({ byDay: values.byDay })
      .from(values)
      .where(sql`${values.id} = 1`);
    expect(row!.byDay).toEqual({ '2024-01-02': 1 });
  });
});

describe('UNION columns', () => {
  const shapes = pgTable('sweep2_unions', {
    id: integer('id'),
    value: duckDbUnion<
      { tag: 'num'; value: number } | { tag: 'label'; value: string }
    >('value', { num: 'INTEGER', label: 'VARCHAR' }),
  });

  test('write and read { tag, value } objects, also through placeholders', async () => {
    const db = await drizzle(':memory:', { pool: false });
    try {
      await db.execute(
        sql`create table sweep2_unions (id integer, value union(num integer, label varchar))`
      );
      await db.insert(shapes).values([
        { id: 1, value: { tag: 'num', value: 5 } },
        { id: 2, value: { tag: 'label', value: "it's" } },
      ]);
      await db
        .insert(shapes)
        .values({ id: 3, value: sql.placeholder('value') })
        .prepare('sweep2_union_insert')
        .execute({ value: { tag: 'label', value: 'x' } });
      expect(await db.select().from(shapes).orderBy(shapes.id)).toEqual([
        { id: 1, value: { tag: 'num', value: 5 } },
        { id: 2, value: { tag: 'label', value: "it's" } },
        { id: 3, value: { tag: 'label', value: 'x' } },
      ]);
      await expect(
        db
          .insert(shapes)
          .values({ id: 4, value: { tag: 'other', value: 1 } as never })
      ).rejects.toThrow(/has no member "other"/);
    } finally {
      await db.close();
    }
  });
});

describe('timestamp decoding', () => {
  test('pre-1970 values with sub-millisecond digits floor to the millisecond', async () => {
    const db = await drizzle(':memory:', { pool: false });
    try {
      const [row] = await db.execute<{
        a: Date;
        b: Date;
        c: unknown;
        d: unknown;
      }>(sql`select
        TIMESTAMP '1969-12-31 23:59:59.9999' as a,
        TIMESTAMPTZ '1960-06-01 12:00:00.000001+00' as b,
        'infinity'::TIMESTAMP as c,
        '-infinity'::TIMESTAMP as d`);
      expect(row!.a.toISOString()).toBe('1969-12-31T23:59:59.999Z');
      expect(row!.b.toISOString()).toBe('1960-06-01T12:00:00.000Z');
      expect(row!.c).toBe('infinity');
      expect(row!.d).toBe('-infinity');
    } finally {
      await db.close();
    }
  });
});

describe('placeholders encoded as SQL', () => {
  test('prepared inserts bind struct, empty list and literal timestamp values', async () => {
    const db = await drizzle(':memory:', { pool: false, prepareCache: true });
    const rows = pgTable('sweep2_placeholders', {
      id: integer('id'),
      struct: duckDbStruct<{ a: number }>('struct', { a: 'INTEGER' }),
      list: duckDbList<number>('list', 'INTEGER'),
      at: duckDbTimestamp('ts', { duckDbType: 'TIMESTAMP_MS' }),
      name: text('name'),
    });
    try {
      await db.execute(sql`create table sweep2_placeholders
        (id integer, struct STRUCT(a INTEGER), list INTEGER[], ts TIMESTAMP_MS, name text)`);
      const insert = db
        .insert(rows)
        .values({
          id: sql.placeholder('id'),
          struct: sql.placeholder('struct'),
          list: sql.placeholder('list'),
          at: sql.placeholder('at'),
          name: sql.placeholder('name'),
        })
        .prepare('sweep2_insert');
      await insert.execute({
        id: 1,
        struct: { a: 1 },
        list: [],
        at: new Date('2024-01-01T00:00:00Z'),
        name: "it's $2",
      });
      await insert.execute({
        id: 2,
        struct: { a: 2 },
        list: [3, 4],
        at: '2024-01-02 00:00:00',
        name: 'b',
      });
      expect(await db.select().from(rows).orderBy(rows.id)).toEqual([
        {
          id: 1,
          struct: { a: 1 },
          list: [],
          at: new Date('2024-01-01T00:00:00Z'),
          name: "it's $2",
        },
        {
          id: 2,
          struct: { a: 2 },
          list: [3, 4],
          at: new Date('2024-01-02T00:00:00Z'),
          name: 'b',
        },
      ]);
    } finally {
      await db.close();
    }
  });
});

describe('transactions on one shared connection', () => {
  const items = pgTable('sweep2_items', { id: integer('id').primaryKey() });

  async function setup() {
    const db = await drizzle(':memory:', { pool: false });
    await db.execute(sql`create table sweep2_items (id integer primary key)`);
    await db.execute(sql`insert into sweep2_items values (999)`);
    return db;
  }

  test('statements outside the transaction neither abort nor join it', async () => {
    const db = await setup();
    try {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const transaction = db.transaction(async (tx) => {
        await tx.insert(items).values({ id: 1 });
        // `db` inside the callback runs immediately instead of deadlocking.
        await db.select().from(items);
        await gate;
        return 'committed';
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const failing = db.insert(items).values({ id: 999 });
      const succeeding = db.insert(items).values({ id: 5 });
      setTimeout(open, 10);

      await expect(failing).rejects.toThrow(/Duplicate key/);
      await succeeding;
      await expect(transaction).resolves.toBe('committed');
      expect(
        await db.execute(sql`select id from sweep2_items order by id`)
      ).toEqual([{ id: 1 }, { id: 5 }, { id: 999 }]);
    } finally {
      await db.close();
    }
  });

  test('concurrent transactions run one after another', async () => {
    const db = await setup();
    try {
      await Promise.all([
        db.transaction((tx) => tx.insert(items).values({ id: 10 })),
        db.transaction((tx) => tx.insert(items).values({ id: 11 })),
      ]);
      expect(
        await db.execute(
          sql`select count(*)::integer as c from sweep2_items where id in (10, 11)`
        )
      ).toEqual([{ c: 2 }]);
    } finally {
      await db.close();
    }
  });

  test('a caught nested failure names the missing savepoints', async () => {
    const db = await setup();
    try {
      const error = await db
        .transaction(async (tx) => {
          await tx
            .transaction(async () => {
              throw new Error('inner failure');
            })
            .catch(() => undefined);
        })
        .catch((reason: unknown) => reason as Error & { cause?: Error });
      expect(error?.message).toMatch(/no savepoints/);
      expect(error?.cause?.message).toBe('inner failure');
    } finally {
      await db.close();
    }
  });
});

test('a stream left open by a pooled transaction is closed before commit', async () => {
  const db = await drizzle(':memory:', { pool: { size: 1 } });
  try {
    const stream = await db.transaction(async (tx) => {
      const batches = tx.executeBatches(sql`select * from range(300000) r(x)`, {
        rowsPerChunk: 1000,
      });
      await batches.next();
      return batches;
    });
    await expect(stream.next()).rejects.toThrow(/transaction ended/);
    expect(await db.execute(sql`select 42 as ok`)).toEqual([{ ok: 42 }]);
  } finally {
    await db.close();
  }
});

test('migrate() tolerates duplicate rows from older journals', async () => {
  const db = await drizzle(':memory:');
  try {
    await db.execute(sql`create schema drizzle`);
    await db.execute(
      sql`create table drizzle.__drizzle_migrations (id integer, hash text not null, created_at bigint)`
    );
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations values (1, 'h', 1000), (2, 'h', 1000)`
    );
    await db.dialect.migrate(
      [
        { hash: 'h', folderMillis: 1000, sql: ['select 1'], bps: true },
        {
          hash: 'next',
          folderMillis: 2000,
          sql: ['create table sweep2_migrated (id integer)'],
          bps: true,
        },
      ],
      db.session,
      { migrationsFolder: '.' }
    );
    expect(
      await db.execute(
        sql`select table_name from information_schema.tables where table_name = 'sweep2_migrated'`
      )
    ).toEqual([{ table_name: 'sweep2_migrated' }]);
  } finally {
    await db.close();
  }
});

describe('parameter binding', () => {
  let db: DuckDBDatabase;
  beforeAll(async () => {
    db = await drizzle(':memory:', { pool: false });
  });
  afterAll(async () => {
    await db.close();
  });

  test("'{}' binds as text instead of an untyped empty list", async () => {
    expect(
      await db.execute(sql`select ${JSON.stringify({})}::json::varchar as v`)
    ).toEqual([{ v: '{}' }]);
  });

  test('lists mixing numbers and bigints bind', async () => {
    expect(await db.execute(sql`select ${wrapList([1, 2n])} as v`)).toEqual([
      { v: [1n, 2n] },
    ]);
  });

  test('lists mixing fractions and unsafe bigints do not round', async () => {
    expect(await db.execute(sql`select ${wrapList([3n, 0.5])} as v`)).toEqual([
      { v: [3, 0.5] },
    ]);
    await expect(
      db.execute(sql`select ${wrapList([9007199254740993n, 0.5])} as v`)
    ).rejects.toThrow(/a DOUBLE would round it/);
  });

  test('plain object parameters fail with a helpful message', async () => {
    await expect(
      db.execute(sql`select ${{ a: 1 } as unknown as string} as v`)
    ).rejects.toThrow(/Cannot bind a plain object/);
  });

  test('suffixed duplicate names skip names the query selects', async () => {
    expect(await db.execute(sql`select 1 as a, 2 as a, 3 as a_1`)).toEqual([
      { a: 1, a_2: 2, a_1: 3 },
    ]);
  });
});

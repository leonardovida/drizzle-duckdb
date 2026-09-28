import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import {
  PgDialect,
  boolean,
  integer,
  pgTable,
  time,
} from 'drizzle-orm/pg-core';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from 'vitest';
import {
  buildListLiteral,
  buildStructLiteral,
  duckDbArray,
  duckDbArrayContains,
  duckDbInet,
  duckDbList,
  duckDbMap,
  duckDbStruct,
  duckDbTime,
} from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

let instance: DuckDBInstance;
let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
let db: DuckDBDatabase;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);
});

afterAll(() => {
  connection.closeSync();
});

describe('struct literal keys', () => {
  const people = pgTable('struct_keys', {
    id: integer('id'),
    s: duckDbStruct<{ name: string }>('s', { name: 'VARCHAR' }),
  });

  test('escapes double quotes in keys without relying on the dialect', () => {
    const key = 'name" := 1) OR TRUE OR struct_pack("x';
    // Drizzle's base PgDialect did not escape identifiers before 0.45.
    const dialect = new PgDialect();
    dialect.escapeName = (name: string) => `"${name}"`;
    const query = dialect.sqlToQuery(buildStructLiteral({ [key]: 'v' }));
    expect(query.sql).toBe(
      `struct_pack("name"" := 1) OR TRUE OR struct_pack(""x" := 'v')`
    );
  });

  test('a crafted filter key cannot match every row', async () => {
    await db.execute(
      sql`create table struct_keys (id integer, s struct(name varchar))`
    );
    await db.execute(
      sql`insert into struct_keys values (1, {'name': 'alice'}), (2, {'name': 'bob'})`
    );
    const filter = JSON.parse(
      '{"name\\" := $1) OR TRUE OR \\"struct_keys\\".\\"s\\" = struct_pack(\\"name": "nobody"}'
    );
    const rows = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.s, filter))
      .catch(() => []);
    expect(rows).toEqual([]);
  });
});

describe('empty lists', () => {
  const lists = pgTable('empty_lists', {
    id: integer('id'),
    l: duckDbList<number>('l', 'INTEGER'),
    a: duckDbArray<string>('a', 'VARCHAR'),
    m: duckDbMap<Record<string, number[]>>('m', 'INTEGER[]'),
    s: duckDbStruct<{ xs: string[] }>('s', { xs: 'VARCHAR[]' }),
  });

  beforeAll(async () => {
    await db.execute(
      sql`create table empty_lists (id integer, l integer[], a varchar[], m map(varchar, integer[]), s struct(xs varchar[]))`
    );
  });

  test('typed empty list literal', () => {
    expect(
      new PgDialect().sqlToQuery(buildListLiteral([], 'INTEGER')).sql
    ).toBe('[]::INTEGER[]');
    expect(new PgDialect().sqlToQuery(buildListLiteral([])).sql).toBe('[]');
  });

  test('inserts and reads back empty lists', async () => {
    await db.insert(lists).values({
      id: 1,
      l: [],
      a: [],
      m: { k: [], j: [1] },
      s: { xs: [] },
    });

    const rows = await db
      .select({ l: lists.l, a: lists.a, s: lists.s })
      .from(lists)
      .where(eq(lists.id, 1));
    expect(rows).toEqual([{ l: [], a: [], s: { xs: [] } }]);

    const map = await db.execute(
      sql`select m['k'] as k, m['j'] as j from empty_lists where id = 1`
    );
    expect(map[0]).toMatchObject({ k: [], j: [1] });
  });

  test('updates a list to empty', async () => {
    await db.insert(lists).values({ id: 2, l: [1, 2] });
    await db.update(lists).set({ l: [] }).where(eq(lists.id, 2));
    const rows = await db
      .select({ l: lists.l })
      .from(lists)
      .where(eq(lists.id, 2));
    expect(rows).toEqual([{ l: [] }]);
  });

  test('duckDbMap still returns DuckDB map entries at runtime', async () => {
    const rows = await db
      .select({ m: lists.m })
      .from(lists)
      .where(eq(lists.id, 1));
    expect(rows[0]!.m).toEqual([
      { key: 'k', value: [] },
      { key: 'j', value: [1] },
    ]);
  });
});

describe('non-finite numbers in list literals', () => {
  test('NaN and Infinity are emitted as DOUBLE literals', async () => {
    const rows = await db.execute(
      sql`select ${duckDbArrayContains(
        sql`['NaN'::DOUBLE, 'Infinity'::DOUBLE, 1.0]`,
        [NaN, Infinity]
      )} as hit`
    );
    expect(rows[0]!.hit).toBe(true);
  });
});

describe('TIME microseconds', () => {
  const times = pgTable('time_micros', {
    id: integer('id'),
    custom: duckDbTime('custom'),
    pg: time('pg'),
  });

  test('keeps sub-millisecond digits', async () => {
    await db.execute(
      sql`create table time_micros (id integer, custom time, pg time)`
    );
    await db.execute(
      sql`insert into time_micros values (1, '12:34:56.123456', '01:02:03.000456'), (2, '12:34:56.5', '00:00:00')`
    );
    const rows = await db
      .select({ custom: times.custom, pg: times.pg })
      .from(times)
      .orderBy(times.id);
    expect(rows).toEqual([
      { custom: '12:34:56.123456', pg: '01:02:03.000456' },
      { custom: '12:34:56.500', pg: '00:00:00.000' },
    ]);
  });
});

describe('result mapping', () => {
  test('structs with an address field are not turned into INET strings', async () => {
    const places = pgTable('places', {
      id: integer('id'),
      info: duckDbStruct<{ address: number; zip: string }>('info', {
        address: 'INTEGER',
        zip: 'VARCHAR',
      }),
    });
    await db.execute(
      sql`create table places (id integer, info struct(address integer, zip varchar))`
    );
    await db.insert(places).values({ id: 1, info: { address: 5, zip: '1' } });
    const rows = await db.select({ info: places.info }).from(places);
    expect(rows).toEqual([{ info: { address: 5, zip: '1' } }]);
  });

  test('a column named enableRLS is selected', async () => {
    const flags = pgTable('rls_flags', {
      id: integer('id'),
      enableRLS: boolean('enable_rls'),
    });
    await db.execute(
      sql`create table rls_flags (id integer, enable_rls boolean)`
    );
    await db.execute(sql`insert into rls_flags values (1, true)`);
    expect(await db.select().from(flags)).toEqual([{ id: 1, enableRLS: true }]);
  });
});

describe('INET values', () => {
  let inetAvailable = true;

  beforeAll(async () => {
    try {
      await db.execute(sql`load inet`);
    } catch {
      try {
        await db.execute(sql`install inet`);
        await db.execute(sql`load inet`);
      } catch {
        inetAvailable = false;
      }
    }
  });

  test('match DuckDB text formatting', async (context) => {
    if (!inetAvailable) {
      context.skip('inet extension is not available');
    }
    const values = [
      '1.2.3.4',
      '10.0.0.0/8',
      '2001:db8::1',
      '::1',
      '::',
      '::ffff:1.2.3.4',
      '::1.2.3.4',
      '2001:db8::/32',
      'fe80::1:2:3:4/64',
      '1:0:0:2:0:0:0:3',
      '8000::1',
      'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    ];
    const table = pgTable('inets', {
      id: integer('id'),
      ip: duckDbInet('ip'),
    });
    await db.execute(sql`create table inets (id integer, ip inet)`);
    await db.insert(table).values(values.map((ip, id) => ({ id, ip })));
    const rows = await db
      .select({ ip: table.ip })
      .from(table)
      .orderBy(table.id);
    const text = await db.execute(
      sql`select ip::varchar as ip from inets order by id`
    );
    expect(rows.map((row) => row.ip)).toEqual(text.map((row) => row.ip));
  });
});

describe('type names', () => {
  test('column helpers accept any DuckDB type string', () => {
    const table = pgTable('wide_types', {
      ids: duckDbList<string>('ids', 'UUID'),
      small: duckDbArray<number>('small', 'TINYINT', 3),
      json: duckDbList<string>('json', 'JSON'),
      money: duckDbMap<Record<string, string>>('money', 'DECIMAL(10, 2)'),
      nested: duckDbMap<Record<string, unknown>>(
        'nested',
        'STRUCT(a INTEGER, b MAP(VARCHAR, INTEGER))'
      ),
      struct: duckDbStruct<{ at: string; span: string }>('struct', {
        at: 'TIMESTAMP WITH TIME ZONE',
        span: 'INTERVAL',
      }),
    });

    expect(table.ids.getSQLType()).toBe('UUID[]');
    expect(table.small.getSQLType()).toBe('TINYINT[3]');
    expect(table.money.getSQLType()).toBe('MAP (STRING, DECIMAL(10, 2))');
    expect(table.struct.getSQLType()).toBe(
      'STRUCT ("at" TIMESTAMP WITH TIME ZONE, "span" INTERVAL)'
    );
    expectTypeOf<'UUID'>().toExtend<Parameters<typeof duckDbList>[1]>();
    expectTypeOf<'DECIMAL(10, 2)'>().toExtend<
      Parameters<typeof duckDbMap>[1]
    >();
  });

  test('duckDbMap keyType sets the MAP key type', async () => {
    const counts = pgTable('int_key_map', {
      id: integer('id'),
      m: duckDbMap<Record<string, string>>('m', 'VARCHAR', {
        keyType: 'INTEGER',
      }),
      e: duckDbMap<Record<string, string>>('e', 'VARCHAR', {
        keyType: 'INTEGER',
      }),
    });
    expect(counts.m.getSQLType()).toBe('MAP (INTEGER, VARCHAR)');

    await db.execute(
      sql`create table int_key_map (id integer, m map(integer, varchar), e map(integer, varchar))`
    );
    await db
      .insert(counts)
      .values({ id: 1, m: { '1': 'one', '2': 'two' }, e: {} });
    const rows = await db.execute(
      sql`select m[2] as two, cardinality(e) as empty from int_key_map`
    );
    expect(rows[0]).toMatchObject({ two: 'two' });
    expect(Number(rows[0]!.empty)).toBe(0);
  });
});

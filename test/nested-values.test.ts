import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildListLiteral,
  buildMapLiteral,
  duckDbArray,
  duckDbArrayContained,
  duckDbArrayContains,
  duckDbArrayOverlaps,
  duckDbBlob,
  duckDbList,
  duckDbMap,
  duckDbStruct,
  duckDbTimestamp,
} from '../src/columns.ts';
import { DuckDBDialect } from '../src/dialect.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

const instant = new Date('2024-01-01T00:00:00.123Z');
const instantMicros = BigInt(instant.getTime()) * 1000n;

let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
let db: DuckDBDatabase;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);
  // A non-UTC zone catches values that are read in the session zone.
  await db.execute(sql`SET TimeZone = 'America/New_York'`);
});

afterAll(() => {
  connection.closeSync();
});

const bytes = (value: unknown) => [...(value as Uint8Array)];

describe('Dates and bytes inside nested literals', () => {
  const structs = pgTable('nested_struct_values', {
    id: integer('id'),
    s: duckDbStruct<{ ts?: Date; n?: Date; b?: Buffer; label?: string }>('s', {
      ts: 'TIMESTAMPTZ',
      n: 'TIMESTAMP',
      b: 'BLOB',
      label: 'VARCHAR',
    }),
  });

  beforeAll(async () => {
    await db.execute(sql`create table nested_struct_values (
      id integer,
      s STRUCT(ts TIMESTAMPTZ, n TIMESTAMP, b BLOB, label VARCHAR)
    )`);
  });

  test('struct fields take Date and Buffer values', async () => {
    await db.insert(structs).values({
      id: 1,
      s: {
        ts: instant,
        n: instant,
        b: Buffer.from([0, 0x27, 0x5c, 0xff]),
        label: "it's",
      },
    });

    const rows = await db.execute<{
      ts: bigint;
      n: string;
      b: Uint8Array;
      label: string;
    }>(sql`select epoch_us(s.ts) as ts, s.n::varchar as n, s.b as b,
      s.label as label from nested_struct_values where id = 1`);
    expect(rows[0]!.ts).toBe(instantMicros);
    expect(rows[0]!.n).toBe('2024-01-01 00:00:00.123');
    expect(bytes(rows[0]!.b)).toEqual([0, 0x27, 0x5c, 0xff]);
    expect(rows[0]!.label).toBe("it's");
  });

  test('list and map literals render Dates by element type', () => {
    const dialect = new DuckDBDialect();
    expect(
      dialect.sqlToQuery(buildListLiteral([instant], 'TIMESTAMP')).sql
    ).toBe("list_value(TIMESTAMP '2024-01-01 00:00:00.123')");
    expect(
      dialect.sqlToQuery(buildMapLiteral({ a: instant }, 'TIMESTAMPTZ')).sql
    ).toBe(
      "map(list_value('a'), list_value(TIMESTAMPTZ '2024-01-01 00:00:00.123+00'))"
    );
    expect(
      dialect.sqlToQuery(buildListLiteral([Buffer.from("'")], 'BLOB')).sql
    ).toBe("list_value(from_hex('27'))");
  });

  test('array predicates take Date values typed from the column', async () => {
    const times = pgTable('nested_predicate_times', {
      id: integer('id'),
      ts: duckDbList<Date>('ts', 'TIMESTAMP'),
      tz: duckDbList<Date>('tz', 'TIMESTAMPTZ'),
    });
    await db.execute(sql`create table nested_predicate_times (
      id integer, ts TIMESTAMP[], tz TIMESTAMPTZ[]
    )`);
    await db.execute(sql`insert into nested_predicate_times values (
      1,
      [TIMESTAMP '2024-01-01 00:00:00.123'],
      [TIMESTAMPTZ '2024-01-01 00:00:00.123+00']
    )`);

    const matches = async (where: ReturnType<typeof duckDbArrayContains>) =>
      (await db.select({ id: times.id }).from(times).where(where)).length;

    expect(await matches(duckDbArrayContains(times.ts, [instant]))).toBe(1);
    expect(await matches(duckDbArrayContains(times.tz, [instant]))).toBe(1);
    expect(await matches(duckDbArrayOverlaps(times.tz, [instant]))).toBe(1);
    expect(await matches(duckDbArrayContained(times.ts, [instant]))).toBe(1);
    expect(
      await matches(
        duckDbArrayContains(times.tz, [new Date('2024-01-01T05:00:00.123Z')])
      )
    ).toBe(0);
  });
});

describe('list, array and map values that cannot be bound as parameters', () => {
  test('lists of structs, blobs and empty inner lists insert', async () => {
    const lists = pgTable('nested_lists', {
      id: integer('id'),
      structs: duckDbList<{ a: number; ts: Date }>(
        'structs',
        'STRUCT (a INTEGER, ts TIMESTAMPTZ)'
      ),
      blobs: duckDbList<Buffer>('blobs', 'BLOB'),
      nested: duckDbList<number[]>('nested', 'INTEGER[]'),
    });
    await db.execute(sql`create table nested_lists (
      id integer,
      structs STRUCT(a INTEGER, ts TIMESTAMPTZ)[],
      blobs BLOB[],
      nested INTEGER[][]
    )`);

    await db.insert(lists).values([
      {
        id: 1,
        structs: [{ a: 1, ts: instant }],
        blobs: [Buffer.from([1, 2]), Buffer.from([])],
        nested: [[]],
      },
      { id: 2, structs: [], blobs: [], nested: [[], [3, 4]] },
    ]);

    const rows = await db
      .select({ nested: lists.nested })
      .from(lists)
      .orderBy(lists.id);
    expect(rows).toEqual([{ nested: [[]] }, { nested: [[], [3, 4]] }]);

    const detail = await db.execute<{ a: number; ts: bigint; b: string }>(
      sql`select structs[1].a as a, epoch_us(structs[1].ts) as ts,
        blobs::varchar as b from nested_lists where id = 1`
    );
    expect(detail[0]).toEqual({
      a: 1,
      ts: instantMicros,
      b: "[\\x01\\x02, '']",
    });
  });

  test('arrays of structs insert', async () => {
    const arrays = pgTable('nested_arrays', {
      id: integer('id'),
      pair: duckDbArray<{ a: number }>('pair', 'STRUCT (a INTEGER)', 2),
    });
    await db.execute(
      sql`create table nested_arrays (id integer, pair STRUCT(a INTEGER)[2])`
    );

    await db.insert(arrays).values({ id: 1, pair: [{ a: 1 }, { a: 2 }] });
    const rows = await db.select({ pair: arrays.pair }).from(arrays);
    expect(rows).toEqual([{ pair: [{ a: 1 }, { a: 2 }] }]);
  });

  test('maps with struct and blob values insert', async () => {
    const maps = pgTable('nested_maps', {
      id: integer('id'),
      structs: duckDbMap<Record<string, { a: number; ts: Date }>>(
        'structs',
        'STRUCT (a INTEGER, ts TIMESTAMPTZ)'
      ),
      blobs: duckDbMap<Record<string, Buffer>>('blobs', 'BLOB'),
    });
    await db.execute(sql`create table nested_maps (
      id integer,
      structs MAP(VARCHAR, STRUCT(a INTEGER, ts TIMESTAMPTZ)),
      blobs MAP(VARCHAR, BLOB)
    )`);

    await db.insert(maps).values({
      id: 1,
      structs: { k: { a: 1, ts: instant } },
      blobs: { k: Buffer.from([0xff]) },
    });

    const rows = await db.execute<{ a: number; ts: bigint; b: Uint8Array }>(
      sql`select structs['k'].a as a, epoch_us(structs['k'].ts) as ts,
        blobs['k'] as b from nested_maps`
    );
    expect(rows[0]!.a).toBe(1);
    expect(rows[0]!.ts).toBe(instantMicros);
    expect(bytes(rows[0]!.b)).toEqual([0xff]);
  });
});

describe('string mode timestamps and blob reads', () => {
  const values = pgTable('string_mode_values', {
    id: integer('id'),
    ts: duckDbTimestamp('ts', { mode: 'string' }),
    tz: duckDbTimestamp('tz', { mode: 'string', withTimezone: true }),
    b: duckDbBlob('b'),
  });
  // TIMETZ is read as text. It must not change how other columns decode.
  const textColumn = sql<string>`TIMETZ '10:00:00+02'`;

  beforeAll(async () => {
    await db.execute(sql`create table string_mode_values (
      id integer, ts TIMESTAMP, tz TIMESTAMPTZ, b BLOB
    )`);
    await db.execute(sql`insert into string_mode_values values
      (1, '2024-01-01 12:00:00.123456', '2024-01-01 12:00:00.123456+00', '\\x01\\x02A'::BLOB),
      (2, '2024-01-15 10:30:00', '2024-01-15 10:30:00+00', NULL)`);
  });

  test('naive TIMESTAMP strings have no offset and TIMESTAMPTZ strings are UTC', async () => {
    const rows = await db
      .select({ ts: values.ts, tz: values.tz })
      .from(values)
      .orderBy(values.id);
    // Date values carry milliseconds only.
    expect(rows).toEqual([
      { ts: '2024-01-01 12:00:00.123', tz: '2024-01-01 12:00:00.123+00' },
      { ts: '2024-01-15 10:30:00', tz: '2024-01-15 10:30:00+00' },
    ]);
  });

  test('a text-read column in the same select does not change string mode output', async () => {
    const rows = await db
      .select({ ts: values.ts, tz: values.tz, t: textColumn })
      .from(values)
      .orderBy(values.id);
    expect(rows.map(({ ts, tz }) => ({ ts, tz }))).toEqual([
      { ts: '2024-01-01 12:00:00.123', tz: '2024-01-01 12:00:00.123+00' },
      { ts: '2024-01-15 10:30:00', tz: '2024-01-15 10:30:00+00' },
    ]);
  });

  test('string mode normalizes TIMESTAMPTZ offsets to UTC', () => {
    expect(values.tz.mapFromDriverValue('2024-01-01 14:00:00.123456+02')).toBe(
      '2024-01-01 12:00:00.123456+00'
    );
    expect(values.ts.mapFromDriverValue('2024-01-01 12:00:00.5')).toBe(
      '2024-01-01 12:00:00.5'
    );
    expect(values.tz.mapFromDriverValue('infinity')).toBe('infinity');
  });

  test('blob columns read Buffers from bytes and from DuckDB text', async () => {
    const decoded = values.b.mapFromDriverValue('\\x01\\x02A\\x5C');
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(bytes(decoded)).toEqual([1, 2, 65, 0x5c]);

    const plain = await db
      .select({ b: values.b })
      .from(values)
      .where(eq(values.id, 1));
    expect(Buffer.isBuffer(plain[0]!.b)).toBe(true);
    expect(bytes(plain[0]!.b)).toEqual([1, 2, 65]);

    const mixed = await db
      .select({ b: values.b, t: textColumn })
      .from(values)
      .where(eq(values.id, 1));
    expect(Buffer.isBuffer(mixed[0]!.b)).toBe(true);
    expect(bytes(mixed[0]!.b)).toEqual([1, 2, 65]);
  });
});

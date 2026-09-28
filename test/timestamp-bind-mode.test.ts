import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { duckDbTimestamp } from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';
import { wrapTimestamp, wrapperToNodeApiValue } from '../src/value-wrappers.ts';

const literalTable = pgTable('ts_modes', {
  id: integer('id'),
  ts: duckDbTimestamp('ts', { bindMode: 'literal' }),
});

const bindTable = pgTable('ts_modes', {
  id: integer('id'),
  ts: duckDbTimestamp('ts', { bindMode: 'bind' }),
});

const autoTable = pgTable('ts_modes', {
  id: integer('id'),
  ts: duckDbTimestamp('ts'),
});

let instance: DuckDBInstance;
let connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
let db: DuckDBDatabase;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  db = drizzle(connection);
  await db.execute(sql`create table ts_modes (id integer, ts timestamp)`);
  await db.execute(
    sql`insert into ts_modes values (1, '2020-01-01'), (2, '2021-01-01')`
  );
});

afterAll(() => {
  connection.closeSync();
});

describe('duckDbTimestamp literal mode', () => {
  test('escapes quotes so a crafted string cannot change the filter', async () => {
    const input = "1999-01-01' OR '1'='1";
    const query = db
      .select({ id: literalTable.id })
      .from(literalTable)
      .where(eq(literalTable.ts, input));

    expect(query.toSQL().sql).toContain(
      "TIMESTAMP '1999-01-01'' OR ''1''=''1'"
    );
    await expect(query).rejects.toThrow();
  });

  test('cannot inject statements through an insert value', async () => {
    await db.execute(sql`create table ts_victim (x integer)`);
    const query = db.insert(literalTable).values({
      id: 3,
      ts: "2024-01-01 00:00:00'); drop table ts_victim; --",
    });

    await expect(query).rejects.toThrow();
    const rows = await db.execute(sql`select count(*) as n from ts_victim`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test('canonicalizes ISO-like strings and Dates', () => {
    const toSql = (value: Date | string) =>
      db
        .select({ id: literalTable.id })
        .from(literalTable)
        .where(eq(literalTable.ts, value))
        .toSQL().sql;

    expect(toSql('2020-01-01T00:00:00Z')).toContain(
      "TIMESTAMP '2020-01-01 00:00:00+00'"
    );
    // A naive TIMESTAMP literal drops the offset, so it is applied first.
    expect(toSql('2020-01-01 10:00:00.123456+05')).toContain(
      "TIMESTAMP '2020-01-01 05:00:00.123456+00'"
    );
    expect(toSql(new Date('2020-01-01T00:00:00.000Z'))).toContain(
      "TIMESTAMP '2020-01-01 00:00:00.000+00'"
    );
  });

  test('matches rows by value', async () => {
    const rows = await db
      .select({ id: literalTable.id })
      .from(literalTable)
      .where(eq(literalTable.ts, '2021-01-01T00:00:00Z'));
    expect(rows).toEqual([{ id: 2 }]);
  });
});

describe('duckDbTimestamp bind mode', () => {
  test('binds values as parameters', async () => {
    const query = db
      .select({ id: bindTable.id })
      .from(bindTable)
      .where(eq(bindTable.ts, '2020-01-01 00:00:00'));

    expect(query.toSQL().sql).toContain('$1');
    expect(await query).toEqual([{ id: 1 }]);
  });

  test('rejects crafted strings before they reach DuckDB', async () => {
    await expect(
      db
        .select({ id: bindTable.id })
        .from(bindTable)
        .where(eq(bindTable.ts, "1999-01-01' OR '1'='1"))
    ).rejects.toThrow(/Invalid timestamp string/);
  });
});

describe('duckDbTimestamp auto mode', () => {
  const previous = process.env.DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS;
    } else {
      process.env.DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS = previous;
    }
  });

  test('DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS forces escaped literals', () => {
    process.env.DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS = '1';
    const query = db
      .select({ id: autoTable.id })
      .from(autoTable)
      .where(eq(autoTable.ts, "x' OR '1'='1"));

    expect(query.toSQL()).toMatchObject({
      sql: expect.stringContaining("TIMESTAMP 'x'' OR ''1''=''1'"),
      params: [],
    });
  });
});

describe('timestamp binding precision', () => {
  const micros = (value: string) =>
    (
      wrapperToNodeApiValue(wrapTimestamp(value, false), () => {
        throw new Error('unexpected nested value');
      }) as { micros: bigint }
    ).micros;

  test('keeps microseconds from strings', () => {
    expect(micros('2024-01-01T10:00:00.123456Z')).toBe(1704103200123456n);
    expect(micros('1969-12-31 23:59:59.123456')).toBe(-876544n);
  });

  test('accepts hour-only and compact offsets', () => {
    expect(micros('2024-01-01 10:00:00+05')).toBe(1704085200000000n);
    expect(micros('2024-01-01 10:00:00+0530')).toBe(1704083400000000n);
    expect(micros('2024-01-01 10:00:00-05:00')).toBe(1704121200000000n);
  });

  test('round trips microseconds through DuckDB', async () => {
    const rows = await db.execute(
      sql`select ${bindTable.ts.mapToDriverValue('2024-01-01 10:00:00.123456')}::varchar as v`
    );
    expect(rows[0]!.v).toBe('2024-01-01 10:00:00.123456');
  });
});

describe('literal and bind modes agree outside UTC', () => {
  const zoneTable = (bindMode: 'bind' | 'literal') =>
    pgTable('ts_zone_modes', {
      id: integer('id'),
      tz: duckDbTimestamp('tz', { withTimezone: true, bindMode }),
      ntz: duckDbTimestamp('ntz', { bindMode }),
    });
  const tables = { bind: zoneTable('bind'), literal: zoneTable('literal') };

  let zoneConnection: Awaited<ReturnType<DuckDBInstance['connect']>>;
  let zoneDb: DuckDBDatabase;

  beforeAll(async () => {
    const zoneInstance = await DuckDBInstance.create(':memory:');
    zoneConnection = await zoneInstance.connect();
    zoneDb = drizzle(zoneConnection);
    await zoneDb.execute(sql`SET TimeZone = 'America/New_York'`);
    await zoneDb.execute(
      sql`create table ts_zone_modes (id integer, tz timestamptz, ntz timestamp)`
    );
  });

  afterAll(() => {
    zoneConnection.closeSync();
  });

  const cases: {
    name: string;
    values: { tz?: Date | string; ntz?: Date | string };
    // `tz` is the stored instant as UTC wall time.
    expected: { tz: string | null; ntz: string | null };
  }[] = [
    {
      name: 'TIMESTAMPTZ string without an offset is UTC',
      values: { tz: '2024-01-01 00:00:00.123456' },
      expected: { tz: '2024-01-01 00:00:00.123456', ntz: null },
    },
    {
      name: 'TIMESTAMPTZ date-only string is UTC midnight',
      values: { tz: '2024-01-01' },
      expected: { tz: '2024-01-01 00:00:00', ntz: null },
    },
    {
      name: 'TIMESTAMPTZ string keeps its offset',
      values: { tz: '2024-01-01 00:00:00-08:00' },
      expected: { tz: '2024-01-01 08:00:00', ntz: null },
    },
    {
      name: 'TIMESTAMP string with an offset is converted to UTC',
      values: { ntz: '2024-01-01 00:00:00.123456+05:00' },
      expected: { tz: null, ntz: '2023-12-31 19:00:00.123456' },
    },
    {
      name: 'TIMESTAMP string without an offset keeps its wall time',
      values: { ntz: '2024-01-01 00:00:00' },
      expected: { tz: null, ntz: '2024-01-01 00:00:00' },
    },
    {
      name: 'Date values store the same instant',
      values: {
        tz: new Date('2024-01-01T00:00:00.123Z'),
        ntz: new Date('2024-01-01T00:00:00.123Z'),
      },
      expected: {
        tz: '2024-01-01 00:00:00.123',
        ntz: '2024-01-01 00:00:00.123',
      },
    },
  ];

  test.each(cases)('$name', async ({ values, expected }) => {
    for (const [id, mode] of (['bind', 'literal'] as const).entries()) {
      await zoneDb.insert(tables[mode]).values({ id, ...values });
    }
    const rows = await zoneDb.execute<{
      id: number;
      tz: string | null;
      ntz: string | null;
    }>(
      sql`select id, (tz at time zone 'UTC')::varchar as tz, ntz::varchar as ntz
        from ts_zone_modes order by id`
    );
    await zoneDb.execute(sql`delete from ts_zone_modes`);

    expect(rows).toEqual([
      { id: 0, ...expected },
      { id: 1, ...expected },
    ]);
  });
});

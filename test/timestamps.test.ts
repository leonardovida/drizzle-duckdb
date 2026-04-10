import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  duckDbDate,
  duckDbTime,
  duckDbTimestamp,
  drizzle,
  type DuckDBDatabase,
} from '../src';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const ENABLE_LOGGING = false;

const timestampsTable = pgTable('duckdb_timestamp_cases', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
  tsWithTz: duckDbTimestamp('ts_with_tz', {
    withTimezone: true,
    mode: 'date',
    precision: 3,
  }),
  tsNoTzString: duckDbTimestamp('ts_no_tz_string', {
    mode: 'string',
  }),
  tsNs: duckDbTimestamp('ts_ns', {
    duckDbType: 'TIMESTAMP_NS',
    mode: 'string',
  }),
  dateCol: duckDbDate('date_col'),
  timeCol: duckDbTime('time_col'),
  timeNs: duckDbTime('time_ns', { duckDbType: 'TIME_NS' }),
  timeWithTz: duckDbTime('time_with_tz', { withTimezone: true }),
});

interface Context {
  db: DuckDBDatabase;
  connection: DuckDBConnection;
}

let ctx: Context;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection, { logger: ENABLE_LOGGING });

  ctx = { db, connection };

  await db.execute(sql`drop table if exists ${timestampsTable}`);
  await db.execute(sql`
    create table ${timestampsTable} (
      id integer primary key,
      label text not null,
      ts_with_tz timestamptz,
      ts_no_tz_string timestamp,
      ts_ns timestamp_ns,
      date_col date,
      time_col time,
      time_ns time_ns,
      time_with_tz time with time zone
    )
  `);
});

beforeEach(async () => {
  await ctx.db.execute(sql`delete from ${timestampsTable}`);
});

afterAll(() => {
  ctx.connection?.closeSync();
});

test('timestamp with timezone maps to Date when mode=date', async () => {
  const value = new Date('2024-03-01T10:20:30.123Z');

  await ctx.db.insert(timestampsTable).values({
    id: 1,
    label: 'with-tz',
    tsWithTz: value,
  });

  const rows = await ctx.db
    .select()
    .from(timestampsTable)
    .where(eq(timestampsTable.id, 1));

  const tsWithTz = rows[0]?.tsWithTz;
  expect(tsWithTz).toBeInstanceOf(Date);
  if (!(tsWithTz instanceof Date)) {
    throw new Error('tsWithTz should be Date');
  }
  expect(tsWithTz.getTime()).toBe(value.getTime());
});

test('timestamp with timezone parses offset strings', async () => {
  const value = '2024-03-01 05:06:07-0500';

  await ctx.db.insert(timestampsTable).values({
    id: 4,
    label: 'with-offset',
    tsWithTz: value,
  });

  const rows = await ctx.db
    .select({ tsWithTz: timestampsTable.tsWithTz })
    .from(timestampsTable)
    .where(eq(timestampsTable.id, 4));

  const ts = rows[0]?.tsWithTz;
  expect(ts).toBeInstanceOf(Date);
  if (ts instanceof Date) {
    expect(ts.getTime()).toBe(new Date('2024-03-01T10:06:07Z').getTime());
  }
});

test('timestamp without timezone maps to string when mode=string', async () => {
  await ctx.db.insert(timestampsTable).values({
    id: 2,
    label: 'no-tz',
    tsNoTzString: '2024-03-01 12:34:56.789',
  });

  const rows = await ctx.db
    .select({ tsNoTzString: timestampsTable.tsNoTzString })
    .from(timestampsTable)
    .where(eq(timestampsTable.id, 2));

  expect(rows[0]!.tsNoTzString).toContain('2024-03-01 12:34:56.789');
});

test('date and time columns round-trip', async () => {
  await ctx.db.insert(timestampsTable).values({
    id: 3,
    label: 'date-time',
    dateCol: '2024-04-05',
    timeCol: '23:59:59',
    timeNs: '23:59:59.123456789',
    timeWithTz: '23:59:59+02',
  });

  const rows = await ctx.db
    .select({
      date: timestampsTable.dateCol,
      time: timestampsTable.timeCol,
      timeNs: timestampsTable.timeNs,
      timeWithTz: timestampsTable.timeWithTz,
    })
    .from(timestampsTable)
    .where(eq(timestampsTable.id, 3));

  expect(
    typeof rows[0]?.date === 'string' || rows[0]?.date instanceof Date
  ).toBe(true);
  expect(typeof rows[0]?.time === 'string').toBe(true);
  expect(rows[0]?.timeNs).toContain('23:59:59');
  expect(rows[0]?.timeWithTz).toContain('+02');
});

test('specialized time helpers preserve DuckDB SQL types', () => {
  expect(timestampsTable.tsWithTz.getSQLType()).toBe('TIMESTAMPTZ');
  expect(timestampsTable.tsNs.getSQLType()).toBe('TIMESTAMP_NS');
  expect(timestampsTable.timeCol.getSQLType()).toBe('TIME');
  expect(timestampsTable.timeNs.getSQLType()).toBe('TIME_NS');
  expect(timestampsTable.timeWithTz.getSQLType()).toBe('TIMETZ');
});

test('timestamp_ns can be read in string mode', async () => {
  await ctx.db.insert(timestampsTable).values({
    id: 5,
    label: 'ts-ns',
    tsNs: '2024-03-01 12:34:56.123456789',
  });

  const rows = await ctx.db
    .select({ tsNs: timestampsTable.tsNs })
    .from(timestampsTable)
    .where(eq(timestampsTable.id, 5));

  expect(rows[0]?.tsNs).toContain('2024-03-01 12:34:56.123456789');
});

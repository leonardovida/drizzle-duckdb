import { sql } from 'drizzle-orm';
import { integer, interval, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { duckDbTimestamp } from '../src/columns.ts';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

const events = pgTable('temporal_events', {
  id: integer('id').primaryKey(),
  naive: timestamp('naive', { mode: 'string' }),
  zoned: timestamp('zoned', { mode: 'string', withTimezone: true }),
  asDate: timestamp('as_date'),
  custom: duckDbTimestamp('custom', { mode: 'string' }),
  span: interval('span'),
});

let db: DuckDBDatabase;

beforeAll(async () => {
  db = await drizzle(':memory:', { pool: false });
  await db.execute(sql`set TimeZone = 'UTC'`);
  await db.execute(sql`
    create table temporal_events (
      id integer primary key,
      naive timestamp,
      zoned timestamptz,
      as_date timestamp,
      custom timestamp,
      span interval
    )
  `);
});

afterAll(async () => {
  await db.close();
});

describe('timestamp string mode', () => {
  test('keeps microseconds through a typed select', async () => {
    await db.insert(events).values({
      id: 1,
      naive: '2024-01-02 03:04:05.123456',
      zoned: '2024-01-02 03:04:05.000001+00',
      asDate: new Date('2024-01-02T03:04:05.123Z'),
      custom: '2024-01-02 03:04:05.1005',
    });

    const [row] = await db
      .select({
        naive: events.naive,
        zoned: events.zoned,
        asDate: events.asDate,
        custom: events.custom,
      })
      .from(events)
      .where(sql`${events.id} = 1`);

    expect(row).toEqual({
      naive: '2024-01-02 03:04:05.123456',
      zoned: '2024-01-02 03:04:05.000001+00',
      asDate: new Date('2024-01-02T03:04:05.123Z'),
      custom: '2024-01-02 03:04:05.1005',
    });
  });

  test('keeps microseconds before 1970', async () => {
    await db.insert(events).values({
      id: 2,
      naive: '1969-12-31 23:59:59.999999',
      custom: '1969-12-31 23:59:59.000001',
    });

    const [row] = await db
      .select({ naive: events.naive, custom: events.custom })
      .from(events)
      .where(sql`${events.id} = 2`);

    expect(row).toEqual({
      naive: '1969-12-31 23:59:59.999999',
      custom: '1969-12-31 23:59:59.000001',
    });
  });

  test('keeps millisecond values unchanged', async () => {
    await db.insert(events).values({ id: 3, naive: '2024-01-02 03:04:05.5' });

    const [row] = await db
      .select({ naive: events.naive })
      .from(events)
      .where(sql`${events.id} = 3`);

    expect(row!.naive).toBe('2024-01-02 03:04:05.500');
  });
});

describe('interval columns', () => {
  test.each([
    ['1 day 2 hours', '1 day 02:00:00'],
    ['14 months 3 days', '1 year 2 months 3 days'],
    ['-90 minutes', '-01:30:00'],
    ['0 seconds', '00:00:00'],
    ['1.5 seconds', '00:00:01.5'],
  ])('reads %s as DuckDB interval text', async (input, expected) => {
    await db.execute(sql`delete from temporal_events where id = 10`);
    await db.insert(events).values({ id: 10, span: input });

    const [row] = await db
      .select({ span: events.span })
      .from(events)
      .where(sql`${events.id} = 10`);

    expect(row!.span).toBe(expected);
  });

  test('round trips the text it returns', async () => {
    await db.execute(sql`delete from temporal_events where id = 11`);
    await db.insert(events).values({ id: 11, span: '1 year 2 months 3 days' });
    const [first] = await db
      .select({ span: events.span })
      .from(events)
      .where(sql`${events.id} = 11`);

    await db.insert(events).values({ id: 12, span: first!.span });
    const [second] = await db
      .select({
        same: sql<boolean>`(select span from temporal_events where id = 11) = ${events.span}`,
      })
      .from(events)
      .where(sql`${events.id} = 12`);

    expect(second!.same).toBe(true);
  });
});

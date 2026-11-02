import { relations, sql } from 'drizzle-orm';
import {
  integer,
  interval,
  numeric,
  pgTable,
  time,
  timestamp,
} from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

const owners = pgTable('rqb_root_owners', {
  id: integer('id').primaryKey(),
});

const readings = pgTable('rqb_root_readings', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id').notNull(),
  naive: timestamp('naive', { mode: 'string' }),
  zoned: timestamp('zoned', { mode: 'string', withTimezone: true }),
  at: time('at_time'),
  span: interval('span'),
  amount: numeric('amount', { precision: 30, scale: 10 }),
});

const ownersRelations = relations(owners, ({ many }) => ({
  readings: many(readings),
}));

const readingsRelations = relations(readings, ({ one }) => ({
  owner: one(owners, {
    fields: [readings.ownerId],
    references: [owners.id],
  }),
}));

const schema = { owners, readings, ownersRelations, readingsRelations };

let db: DuckDBDatabase<typeof schema>;

beforeAll(async () => {
  db = await drizzle(':memory:', { pool: false, schema });
  await db.execute(sql`set TimeZone = 'America/New_York'`);
  await db.execute(sql`create table rqb_root_owners (id integer primary key)`);
  await db.execute(sql`
    create table rqb_root_readings (
      id integer primary key,
      owner_id integer not null,
      naive timestamp,
      zoned timestamptz,
      at_time time,
      span interval,
      amount decimal(30, 10)
    )
  `);
  await db.insert(owners).values({ id: 1 });
  await db.insert(readings).values({
    id: 1,
    ownerId: 1,
    naive: '2024-03-10 02:30:00.123456',
    zoned: '2024-03-10 07:30:00.654321+00',
    at: '23:59:59.999999',
    span: '1 month 2 days 03:04:05.5',
    amount: '12345678901234567890.0123456789',
  });
});

afterAll(async () => {
  await db.close();
});

const expected = {
  id: 1,
  ownerId: 1,
  naive: '2024-03-10 02:30:00.123456',
  zoned: '2024-03-10 07:30:00.654321+00',
  at: '23:59:59.999999',
  span: '1 month 2 days 03:04:05.5',
  amount: '12345678901234567890.0123456789',
};

describe('relational query root rows', () => {
  test('decode like a flat select', async () => {
    const [flat] = await db.select().from(readings);
    expect(flat).toEqual(expected);

    const rows = await db.query.readings.findMany({ with: { owner: true } });
    expect(rows).toEqual([{ ...expected, owner: { id: 1 } }]);

    const first = await db.query.readings.findFirst();
    expect(first).toEqual(expected);
  });

  test('keep DECIMAL extras as numbers', async () => {
    const rows = await db.query.readings.findMany({
      columns: { id: true, amount: true },
      extras: {
        doubled: sql<number>`${readings.amount} * 2`.as('doubled'),
      },
    });
    expect(rows).toEqual([
      {
        id: 1,
        amount: '12345678901234567890.0123456789',
        doubled: 24691357802469135780.0246913578,
      },
    ]);
  });

  test('work through prepared relational queries', async () => {
    const prepared = db.query.readings
      .findFirst({
        columns: { at: true, span: true },
        where: (fields, { eq }) => eq(fields.id, sql.placeholder('id')),
      })
      .prepare('rqb_root_prepared');

    expect(await prepared.execute({ id: 1 })).toEqual({
      at: '23:59:59.999999',
      span: '1 month 2 days 03:04:05.5',
    });
  });
});

describe('relational query nested rows', () => {
  test('keep numeric() digits', async () => {
    const rows = await db.query.owners.findMany({
      with: { readings: { columns: { amount: true } } },
    });
    expect(rows).toEqual([
      { id: 1, readings: [{ amount: '12345678901234567890.0123456789' }] },
    ]);
  });
});

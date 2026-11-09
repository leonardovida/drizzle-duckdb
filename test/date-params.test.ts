import { DuckDBInstance } from '@duckdb/node-api';
import { gte, sql } from 'drizzle-orm';
import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { expect, test } from 'vitest';
import { drizzle } from '../src/driver.ts';

const events = pgTable('date_param_events', {
  id: integer('id'),
  at: timestamp('seen', { withTimezone: true }),
});

const instant = new Date('2024-01-01T10:00:00Z');

async function open(dateParams?: 'timestamp' | 'timestamptz') {
  const instance = await DuckDBInstance.create(':memory:');
  const db = drizzle(await instance.connect(), { dateParams });
  await db.execute(sql`set timezone = 'America/New_York'`);
  await db.execute(
    sql`create table date_param_events(id integer, seen timestamptz)`
  );
  await db.execute(
    sql`insert into date_param_events values (1, '2024-01-01 10:00:00+00')`
  );
  return db;
}

test("dateParams 'timestamptz' binds a bare Date as an instant", async () => {
  const db = await open('timestamptz');
  try {
    expect(
      await db
        .select({ id: events.id })
        .from(events)
        .where(sql`${events.at} = ${instant}`)
    ).toEqual([{ id: 1 }]);
    expect(
      await db.execute(
        sql`select typeof(${instant}) as type, ${instant} = timestamptz '2024-01-01 10:00:00+00' as same`
      )
    ).toEqual([{ type: 'TIMESTAMP WITH TIME ZONE', same: true }]);

    const batches: unknown[] = [];
    for await (const batch of db.executeBatches(
      sql`select id from date_param_events where seen = ${instant}`
    )) {
      batches.push(...batch);
    }
    expect(batches).toEqual([{ id: 1 }]);
    expect(
      await db.executeArrow(
        sql`select id from date_param_events where seen = ${instant}`
      )
    ).toEqual({ id: [1] });
  } finally {
    await db.close();
  }
});

test('the default keeps binding a bare Date as a naive UTC TIMESTAMP', async () => {
  const db = await open();
  try {
    expect(
      await db.execute(
        sql`select typeof(${instant}) as type, ${instant}::varchar as text`
      )
    ).toEqual([{ type: 'TIMESTAMP', text: '2024-01-01 10:00:00' }]);
    // Typed operators encode the instant themselves and match either way.
    expect(
      await db
        .select({ id: events.id })
        .from(events)
        .where(gte(events.at, instant))
    ).toEqual([{ id: 1 }]);
  } finally {
    await db.close();
  }
});

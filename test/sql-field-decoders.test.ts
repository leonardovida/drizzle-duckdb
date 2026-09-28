import { sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  drizzle,
  duckDbJson,
  duckDbTime,
  duckDbTimestamp,
  type DuckDBDatabase,
} from '../src/index.ts';

const events = pgTable('decoder_events', {
  id: integer('id'),
  data: duckDbJson<{ code: string }>('data'),
  at: duckDbTime('tm'),
  ts: duckDbTimestamp('ts'),
});

let db: DuckDBDatabase;

beforeAll(async () => {
  db = await drizzle(':memory:');
  await db.execute(sql`
    create table decoder_events (id integer, data json, tm time, ts timestamp);
    insert into decoder_events values
      (1, '{"code":"true"}', '13:45:00', '2024-01-02 03:04:05'),
      (2, '{"code":"007"}', '08:00:00', '2024-01-02 03:04:05');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe('SQL fields that mention a custom column', () => {
  test('use the SQL decoder instead of the column decoder', async () => {
    const rows = await db
      .select({
        hour: sql<number>`extract(hour from ${events.at})`,
        count: sql<number>`count(${events.at}) over ()`,
        epoch: sql<number>`epoch_ms(${events.ts})`,
        code: sql<string>`${events.data}->>'code'`,
      })
      .from(events)
      .orderBy(events.id);

    expect(rows).toEqual([
      { hour: 13n, count: 2n, epoch: 1704164645000n, code: 'true' },
      { hour: 8n, count: 2n, epoch: 1704164645000n, code: '007' },
    ]);
  });

  test('respect mapWith()', async () => {
    const rows = await db
      .select({
        code: sql`${events.data}->>'code'`.mapWith(String),
        hour: sql`extract(hour from ${events.at})`.mapWith(Number),
      })
      .from(events)
      .orderBy(events.id);

    expect(rows).toEqual([
      { code: 'true', hour: 13 },
      { code: '007', hour: 8 },
    ]);
  });

  test('a bare column wrapper still decodes with the column', async () => {
    const rows = await db
      .select({
        data: sql`${events.data}`.as('data_alias'),
        at: sql`${events.at}`,
        ts: events.ts,
      })
      .from(events)
      .orderBy(events.id);

    expect(rows[0]).toEqual({
      data: { code: 'true' },
      at: '13:45:00.000',
      ts: new Date('2024-01-02T03:04:05.000Z'),
    });
  });
});

import { createRequire } from 'node:module';
import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { integer, pgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  drizzle,
  duckDbBlob,
  duckDbTimestamp,
  type DuckDBDatabase,
} from '../src/index.ts';

const nodeApiVersion = (
  createRequire(import.meta.url)('@duckdb/node-api/package.json') as {
    version: string;
  }
).version;
const supportsTimeNs = !nodeApiVersion.startsWith('1.4.');

const columns = sql.raw(`
  1::BIGINT AS big,
  '\\x01\\x02'::BLOB AS b,
  DATE '2024-01-01' AS dt,
  TIMESTAMP '2024-01-01 12:00:00' AS ts
`);

function shape(row: Record<string, unknown> | undefined) {
  return {
    big: typeof row?.big,
    b: row?.b instanceof Uint8Array,
    dt: row?.dt instanceof Date,
    ts: row?.ts instanceof Date,
  };
}

const expectedShape = { big: 'bigint', b: true, dt: true, ts: true };

describe('result conversion per column', () => {
  let instance: DuckDBInstance;
  let db: DuckDBDatabase;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = drizzle(await instance.connect());
  });

  afterAll(async () => {
    await db.close();
    instance.closeSync();
  });

  test.each([
    [
      'TIMESTAMP_NS',
      `'2024-01-01 12:00:00.123456789'::TIMESTAMP_NS`,
      '2024-01-01 12:00:00.123456789',
    ],
    ['TIME_TZ', `'12:00:00+02'::TIMETZ`, '12:00:00+02'],
    // TIME_NS is new in DuckDB 1.5.
    ...(supportsTimeNs
      ? [['TIME_NS', `'12:00:00.123456789'::TIME_NS`, '12:00:00.123456789']]
      : []),
  ])(
    'a %s column keeps its string value and leaves other columns alone',
    async (_type, expression, expected) => {
      const query = sql`select ${columns}, ${sql.raw(expression)} as precise`;

      const [row] = await db.execute<Record<string, unknown>>(query);
      expect(shape(row)).toEqual(expectedShape);
      expect(row?.precise).toBe(expected);

      const batches: Record<string, unknown>[] = [];
      for await (const batch of db.executeBatches(query)) {
        batches.push(...batch);
      }
      expect(shape(batches[0])).toEqual(expectedShape);
      expect(batches[0]?.precise).toBe(expected);

      const arrow = (await db.executeArrow(query)) as Record<string, unknown[]>;
      expect(typeof arrow.big?.[0]).toBe('bigint');
      expect(arrow.b?.[0]).toBeInstanceOf(Uint8Array);
      expect(arrow.precise?.[0]).toBe(expected);
    }
  );

  test('typed blob columns stay binary next to a TIMESTAMP_NS column', async () => {
    const t = pgTable('conv_blob', {
      id: integer('id'),
      b: duckDbBlob('b'),
      tns: duckDbTimestamp('tns', { mode: 'string', precision: 9 }),
    });
    await db.execute(
      sql`create table conv_blob as select 1 as id, '\\x01\\x02'::BLOB as b, '2024-01-01 12:00:00.123456789'::TIMESTAMP_NS as tns`
    );

    const [row] = await db.select({ b: t.b, tns: t.tns }).from(t);
    expect(row?.b).toBeInstanceOf(Uint8Array);
    expect(Array.from(row?.b ?? [])).toEqual([1, 2]);
  });

  test('executeArrow names duplicate columns like execute', async () => {
    const query = sql`select 1 as a, 2 as a`;

    expect(await db.execute(query)).toEqual([{ a: 1, a_1: 2 }]);
    expect(await db.executeArrow(query)).toEqual({ a: [1], a_1: [2] });
  });
});

import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { drizzle, type DuckDBDatabase } from '../src/driver.ts';

const pollutionMarker = 'drizzleDuckdbPollutionProbe';

let db: DuckDBDatabase;
let instance: DuckDBInstance;

beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  db = drizzle(connection);
});

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>)[pollutionMarker];
});

afterAll(async () => {
  await db.close();
  instance.closeSync?.();
});

test('raw result rows preserve __proto__ as an own data property', async () => {
  const [row] = await db.execute(
    sql.raw('select 42 as "__proto__", 7 as "constructor", 9 as normal')
  );

  expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  expect(Object.hasOwn(row, '__proto__')).toBe(true);
  expect(row?.['__proto__']).toBe(42);
  expect(row?.constructor).toBe(7);
  expect(row?.normal).toBe(9);
});

test('nested selection paths cannot mutate Object.prototype', async () => {
  const fields = Object.fromEntries([
    ['__proto__', Object.fromEntries([[pollutionMarker, sql<number>`123`]])],
    [
      'constructor',
      Object.fromEntries([
        ['prototype', Object.fromEntries([['safe', sql<number>`456`]])],
      ]),
    ],
  ]);

  const [row] = await db.select(fields).from(sql`(select 1) as source`);

  expect(Object.prototype).not.toHaveProperty(pollutionMarker);
  expect(Object.hasOwn(row, '__proto__')).toBe(true);
  expect(row?.['__proto__']).toEqual({ [pollutionMarker]: 123 });
  expect(row?.constructor).toEqual({ prototype: { safe: 456 } });
});

test('streamed object rows preserve __proto__ columns', async () => {
  const chunks = [];

  for await (const chunk of db.executeBatches(
    sql.raw('select 42 as "__proto__"'),
    { rowsPerChunk: 1 }
  )) {
    chunks.push(chunk);
  }

  expect(Object.hasOwn(chunks[0]?.[0], '__proto__')).toBe(true);
  expect(chunks[0]?.[0]?.['__proto__']).toBe(42);
});

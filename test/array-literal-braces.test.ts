import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { coerceArrayString } from '../src/array-literals.ts';
import { drizzle } from '../src/driver.ts';

test('array coercion preserves quoted braces and escaped string contents', () => {
  const values = ['a{b}', 'x}', '{', 'quote"{value}', 'slash\\', ''];
  const literal = `{${values.map((value) => JSON.stringify(value)).join(',')}}`;
  expect(coerceArrayString(literal)).toEqual(values);
  expect(coerceArrayString(`{${literal},${literal}}`)).toEqual([
    values,
    values,
  ]);
  expect(coerceArrayString(JSON.stringify(values))).toEqual(values);
});

test('string array parameters round-trip like native arrays in DuckDB', async () => {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);
  try {
    const values = ['a{b}', 'x}', 'quote"{value}', 'slash\\'];
    const literal = `{${values.map((value) => JSON.stringify(value)).join(',')}}`;
    const fromLiteral = await db.execute(
      sql`select ${literal}::varchar[] as items`
    );
    const fromNative = await db.execute(
      sql`select ${sql.param(values)}::varchar[] as items`
    );
    expect(fromLiteral).toEqual([{ items: values }]);
    expect(fromLiteral).toEqual(fromNative);
  } finally {
    await db.close();
    instance.closeSync();
  }
});

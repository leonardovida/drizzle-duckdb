import { DuckDBInstance } from '@duckdb/node-api';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
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

test('brace-shaped strings bound to non-array columns stay strings', async () => {
  const notes = pgTable('array_literal_notes', {
    id: integer('id').primaryKey(),
    body: text('body'),
    tags: text('tags').array(),
  });
  const db = await drizzle(':memory:');
  try {
    await db.execute(sql`
      create table array_literal_notes (id integer primary key, body text, tags text[])
    `);
    const bodies = ['{}', '{1,2}', ' {a,b} ', '{"x":1}'];
    await db
      .insert(notes)
      .values(bodies.map((body, id) => ({ id, body, tags: ['a', 'b'] })));

    const rows = await db.select().from(notes).orderBy(notes.id);
    expect(rows).toEqual(
      bodies.map((body, id) => ({ id, body, tags: ['a', 'b'] }))
    );

    const matches = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.body, '{1,2}'));
    expect(matches).toEqual([{ id: 1 }]);

    // Insert placeholders keep their column encoder until execution.
    const prepared = db
      .insert(notes)
      .values({ id: sql.placeholder('id'), body: sql.placeholder('body') })
      .prepare('brace_body_insert');
    await prepared.execute({ id: 10, body: '{}' });
    expect(
      await db.select({ body: notes.body }).from(notes).where(eq(notes.id, 10))
    ).toEqual([{ body: '{}' }]);
  } finally {
    await db.close();
  }
});

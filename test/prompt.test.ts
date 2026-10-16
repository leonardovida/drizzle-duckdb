import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql/sql';
import { expect, expectTypeOf, test } from 'vitest';
import { DuckDBDialect } from '../src/dialect.ts';
import { mdPrompt } from '../src/prompt.ts';

const dialect = new DuckDBDialect();

test('prompt binds the input and inlines its settings', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPrompt(sql`review`, {
      model: 'gpt-6-luna',
      reasoningEffort: 'low',
      struct: { sentiment: 'VARCHAR', "reviewer's age": 'INTEGER' },
      structDescr: { sentiment: 'positive, neutral or negative' },
    })}
  `);

  expect(query.sql).toContain(
    "prompt(CAST(review AS VARCHAR), model := 'gpt-6-luna', reasoning_effort := 'low', struct := {'sentiment': 'VARCHAR', 'reviewer''s age': 'INTEGER'}, struct_descr := {'sentiment': 'positive, neutral or negative'})"
  );
  expect(query.params).toEqual([]);

  const plain = dialect.sqlToQuery(
    sql`select ${mdPrompt('Summarize DuckDB', { temperature: 0.5 })}`
  );
  expect(plain.sql).toContain(
    'prompt(CAST($1 AS VARCHAR), temperature := 0.5)'
  );
  expect(plain.params).toEqual(['Summarize DuckDB']);
});

test('prompt serializes JSON schemas and return types', () => {
  const schema = dialect.sqlToQuery(sql`
    select ${mdPrompt('text', {
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })}
  `);
  expect(schema.sql).toContain(
    `json_schema := '{"type":"object","properties":{"ok":{"type":"boolean"}}}'`
  );

  const returnType = dialect.sqlToQuery(
    sql`select ${mdPrompt<string[]>('text', { returnType: 'VARCHAR[]' })}`
  );
  expect(returnType.sql).toContain("return_type := 'VARCHAR[]'");
  expectTypeOf(mdPrompt('text')).toEqualTypeOf<SQL<string | null>>();
  expectTypeOf(
    mdPrompt<string[]>('text', { returnType: 'VARCHAR[]' })
  ).toEqualTypeOf<SQL<string[] | null>>();
});

test('prompt rejects settings MotherDuck would refuse', () => {
  expect(() => mdPrompt('x', { temperature: 2 })).toThrow(/from 0 to 1/);
  expect(() => mdPrompt('x', { temperature: Number.NaN })).toThrow(
    /from 0 to 1/
  );
  expect(() => mdPrompt('x', { reasoningEffort: 'max' as 'high' })).toThrow(
    /reasoningEffort must be one of/
  );
  expect(() =>
    mdPrompt('x', { struct: { a: 'VARCHAR' }, returnType: 'INTEGER' })
  ).toThrow(/cannot be combined/);
  expect(() => mdPrompt('x', { structDescr: { a: 'b' } })).toThrow(
    /structDescr requires struct/
  );
  expect(() => mdPrompt('x', { struct: {} })).toThrow(/at least one field/);
  expect(() =>
    mdPrompt('x', { struct: { Name: 'VARCHAR', name: 'INTEGER' } })
  ).toThrow(/"Name" and "name" differ only in case/);
  expect(() =>
    mdPrompt('x', {
      model: 'gpt-5',
      temperature: 0.2,
      reasoningEffort: 'low',
    })
  ).toThrow(/temperature and reasoningEffort cannot be combined/);
  expect(() => mdPrompt('x', { model: '' })).toThrow(
    /model must be a non-empty string/
  );
  expect(() => mdPrompt('x', { model: "gpt-5'\0" })).toThrow(/NULL byte/);
});

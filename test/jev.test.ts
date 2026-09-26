import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { DuckDBDialect } from '../src/dialect.ts';
import { mdPromptJev, type MotherDuckPromptJevOptions } from '../src/jev.ts';

const dialect = new DuckDBDialect();

test('prompt_jev binds only the input and keeps question metadata constant', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev("It isn't working", {
      instructions: "Which team's queue?",
      choice: ['billing', "customer's support"],
      batchSize: 2,
    })} as routing
  `);

  expect(query.sql).toContain(
    "prompt_jev(CAST($1 AS VARCHAR), 'Which team''s queue?', choice := ['billing', 'customer''s support'], batch_size := 2)"
  );
  expect(query.params).toEqual(["It isn't working"]);
});

test('prompt_jev supports score and labeled yes-no criteria', () => {
  const score = dialect.sqlToQuery(sql`
    select ${mdPromptJev(sql`message`, {
      instructions: 'Rate severity',
      score: ['low', 'medium', 'high'],
    })}
  `);
  const noul = dialect.sqlToQuery(sql`
    select ${mdPromptJev(sql`message`, {
      instructions: 'Does this request a refund?',
      noul: [
        { label: 'true', description: 'A refund is requested' },
        { label: 'false' },
      ],
    })}
  `);

  expect(score.sql).toContain("score := ['low', 'medium', 'high']");
  expect(noul.sql).toContain(
    "noul := [{label: 'true', description: 'A refund is requested'}, {label: 'false', description: NULL}]"
  );
  expect(score.params).toEqual([]);
  expect(noul.params).toEqual([]);
});

test('prompt_jev supports multiple questions as a constant STRUCT', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev('A refund is overdue', {
      questions: {
        refund: {
          type: 'noul',
          instructions: "Doesn't this request a refund?",
        },
        team: {
          type: 'choice',
          instructions: 'Choose a team',
          criteria: ['billing', 'technical'],
        },
      },
    })}
  `);

  expect(query.sql).toContain(
    "questions := {'refund': {type: 'noul', instructions: 'Doesn''t this request a refund?'}, 'team': {type: 'choice', instructions: 'Choose a team', criteria: ['billing', 'technical']}}"
  );
  expect(query.params).toEqual(['A refund is overdue']);
});

test('prompt_jev preserves the JSON question escape hatch', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev('message', {
      questions: '{"refund":{"type":"noul","instructions":"Refund?"}}',
    })}
  `);

  expect(query.sql).toContain(
    'questions := \'{"refund":{"type":"noul","instructions":"Refund?"}}\'::JSON'
  );
});

test('prompt_jev rejects invalid inlined constants', () => {
  expect(() =>
    mdPromptJev('message', { instructions: 'Question', batchSize: 0 })
  ).toThrow(/batchSize/);
  expect(() => mdPromptJev('message', { instructions: 'bad\0input' })).toThrow(
    /NULL byte/
  );
  expect(() =>
    mdPromptJev('message', {
      instructions: 'Question',
      choice: ['a', 'b'],
      score: ['low', 'high'],
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/cannot be combined/);
});

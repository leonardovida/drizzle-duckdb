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

test('prompt_jev rejects question sets that would produce invalid SQL', () => {
  expect(() => mdPromptJev('message', { questions: {} })).toThrow(
    /at least one question/
  );
  expect(() => mdPromptJev('message', { questions: '  ' })).toThrow(
    /questions JSON must not be empty/
  );
  expect(() =>
    mdPromptJev('message', {
      questions: { team: { type: 'choice', instructions: 'Team?' } },
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/question "team" of type 'choice' requires criteria/);
  expect(() =>
    mdPromptJev('message', {
      questions: {
        team: { type: 'choice', instructions: 'Team?', criteria: [] },
      },
    })
  ).toThrow(/question "team" criteria must be a non-empty array/);
  expect(() =>
    mdPromptJev('message', {
      questions: { refund: { type: 'noul' } },
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/question "refund" instructions must be a non-empty string/);
  expect(() =>
    mdPromptJev('message', {
      questions: { refund: { instructions: 'Refund?' } },
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/question "refund" type must be a non-empty string/);
});

test('prompt_jev treats an undefined questions key as single question mode', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev('message', {
      questions: undefined,
      instructions: 'Refund?',
    })}
  `);
  expect(query.sql).toContain("prompt_jev(CAST($1 AS VARCHAR), 'Refund?')");

  expect(() =>
    mdPromptJev('message', {
      questions: undefined,
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/instructions must be a non-empty string/);
});

test('prompt_jev validates single question instructions and criteria', () => {
  expect(() =>
    mdPromptJev('message', {} as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/instructions must be a non-empty string/);
  expect(() =>
    mdPromptJev('message', {
      instructions: 42,
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/instructions must be a non-empty string/);
  expect(() =>
    mdPromptJev('message', { instructions: 'Team?', choice: [] })
  ).toThrow(/choice must be a non-empty array/);
  expect(() =>
    mdPromptJev('message', { instructions: 'Severity?', score: [] })
  ).toThrow(/score must be a non-empty array/);
  expect(() =>
    mdPromptJev('message', {
      instructions: 'Refund?',
      noul: [{ description: 'missing label' }],
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/noul labels must be strings/);
});

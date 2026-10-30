import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql/sql';
import { expect, expectTypeOf, test } from 'vitest';
import { DuckDBDialect } from '../src/dialect.ts';
import {
  mdPromptJev,
  type MotherDuckJevBoxResult,
  type MotherDuckJevChoiceResult,
  type MotherDuckJevQuestion,
  type MotherDuckJevMultipleChoiceResult,
  type MotherDuckJevScoreResult,
  type MotherDuckPromptJevOptions,
} from '../src/jev.ts';

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
    "noul := [{label: 'true', description: 'A refund is requested'}, {label: 'false', description: NULL::VARCHAR}]"
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

test('prompt_jev accepts a batch size with a question set', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev(sql`message`, {
      questions: { refund: { type: 'noul', instructions: 'Refund?' } },
      batchSize: 16,
    })}
  `);
  expect(query.sql).toContain(
    "prompt_jev(CAST(message AS VARCHAR), questions := {'refund': {type: 'noul', instructions: 'Refund?'}}, batch_size := 16)"
  );
  expect(() =>
    mdPromptJev([{ name: 'a', image: sql`img` }], {
      questions: { where: { type: 'box', instructions: 'region' } },
      batchSize: 2,
    })
  ).toThrow(/batchSize is not supported with image input/);
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

test('prompt_jev supports multiple choice criteria', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev(sql`message`, {
      instructions: 'Which features does this request?',
      multipleChoice: [
        { label: 'api', description: 'Programmatic API access' },
        { label: 'sso' },
      ],
      batchSize: 8,
    })}
  `);

  expect(query.sql).toContain(
    "prompt_jev(CAST(message AS VARCHAR), 'Which features does this request?', multiple_choice := [{label: 'api', description: 'Programmatic API access'}, {label: 'sso', description: NULL::VARCHAR}], batch_size := 8)"
  );
  expect(() =>
    mdPromptJev('message', {
      instructions: 'Features?',
      multipleChoice: ['api'],
      choice: ['a', 'b'],
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/cannot be combined/);
});

test('prompt_jev builds named image input for classification and boxes', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const classify = dialect.sqlToQuery(sql`
    select ${mdPromptJev(
      [
        { name: 'receipt', image: bytes, format: 'png' },
        { name: 'photo', image: sql`photo_bytes` },
      ],
      { instructions: 'Is `receipt` itemized?' }
    )}
  `);
  expect(classify.sql).toContain(
    "prompt_jev([{name: 'receipt', image: CAST($1 AS BLOB), format: 'png'}, {name: 'photo', image: photo_bytes, format: 'jpg'}], 'Is `receipt` itemized?')"
  );
  expect(classify.params).toEqual([bytes]);

  const box = dialect.sqlToQuery(sql`
    select ${mdPromptJev([{ name: 'receipt', image: sql`image_blob` }], {
      box: 'the itemized section in `receipt`',
    })}
  `);
  expect(box.sql).toContain(
    "prompt_jev([{name: 'receipt', image: image_blob}], box := 'the itemized section in `receipt`')"
  );

  const questions = dialect.sqlToQuery(sql`
    select ${mdPromptJev([{ name: 'pet', image: sql`img` }], {
      questions: {
        animal: {
          type: 'choice',
          instructions: 'Which animal is in `pet`?',
          criteria: ['cat', 'dog'],
        },
        location: { type: 'box', instructions: 'the animal in `pet`' },
      },
    })}
  `);
  expect(questions.sql).toContain(
    "questions := {'animal': {type: 'choice', instructions: 'Which animal is in `pet`?', criteria: ['cat', 'dog']}, 'location': {type: 'box', instructions: 'the animal in `pet`'}}"
  );
});

test('prompt_jev accepts a bare BLOB and a single named image', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);

  const bare = dialect.sqlToQuery(sql`
    select ${mdPromptJev(bytes, { instructions: 'Does `image` show a duck?' })}
  `);
  expect(bare.sql).toContain(
    "prompt_jev(CAST($1 AS BLOB), 'Does `image` show a duck?')"
  );
  expect(bare.params).toEqual([bytes]);

  const bareColumn = dialect.sqlToQuery(sql`
    select ${mdPromptJev(
      { image: sql`content` },
      { box: 'the duck in `image`' }
    )}
  `);
  expect(bareColumn.sql).toContain(
    "prompt_jev(CAST(content AS BLOB), box := 'the duck in `image`')"
  );

  const named = dialect.sqlToQuery(sql`
    select ${mdPromptJev(
      { name: 'receipt', image: sql`content` },
      { instructions: 'Is `receipt` an itemized receipt?' }
    )}
  `);
  expect(named.sql).toContain(
    "prompt_jev({name: 'receipt', content: content}, 'Is `receipt` an itemized receipt?')"
  );

  const withFormat = dialect.sqlToQuery(sql`
    select ${mdPromptJev(
      { name: 'diagram', image: bytes, format: 'png' },
      {
        questions: {
          flowchart: {
            type: 'noul',
            instructions: 'Does `diagram` contain a flowchart?',
          },
          where: { type: 'box', instructions: 'the flowchart in `diagram`' },
        },
      }
    )}
  `);
  expect(withFormat.sql).toContain(
    "prompt_jev({name: 'diagram', content: CAST($1 AS BLOB), format: 'png'}, questions := "
  );
  expect(withFormat.params).toEqual([bytes]);

  const defaultName = dialect.sqlToQuery(sql`
    select ${mdPromptJev(
      { image: sql`content`, format: 'jpeg' },
      { instructions: 'Is `image` blurry?' }
    )}
  `);
  expect(defaultName.sql).toContain(
    "prompt_jev({name: 'image', content: content, format: 'jpeg'}, 'Is `image` blurry?')"
  );

  expect(() =>
    mdPromptJev(bytes, { instructions: 'Duck?', batchSize: 2 })
  ).toThrow(/batchSize is not supported with image input/);
  expect(() =>
    mdPromptJev(
      { image: sql`content` },
      { instructions: 'Duck?', batchSize: 2 }
    )
  ).toThrow(/batchSize is not supported with image input/);
  expect(() =>
    mdPromptJev({ name: '', image: sql`content` }, { instructions: 'Duck?' })
  ).toThrow(/image name must be a non-empty string/);
  expect(() =>
    mdPromptJev(
      { image: sql`content`, format: 'gif' as 'png' },
      { instructions: 'Duck?' }
    )
  ).toThrow(/"image" format must be one of png, jpg or jpeg/);
  expect(() =>
    mdPromptJev(
      { image: 'not bytes' as unknown as Uint8Array },
      { instructions: 'Duck?' }
    )
  ).toThrow(/must be a Uint8Array or SQL expression/);
  expectTypeOf(
    mdPromptJev({ image: sql`content` }, { box: 'region' })
  ).toEqualTypeOf<SQL<MotherDuckJevBoxResult | null>>();
});

test('prompt_jev rejects question names that collide in a STRUCT', () => {
  expect(() =>
    mdPromptJev('x', {
      questions: {
        Refund: { type: 'noul', instructions: 'Refund?' },
        refund: { type: 'noul', instructions: 'Refund again?' },
      },
    })
  ).toThrow(/"Refund" and "refund" differ only in case/);
});

test('prompt_jev rejects image settings MotherDuck would refuse', () => {
  const image = { name: 'receipt', image: sql`img` };
  expect(() => mdPromptJev('text', { box: 'region' })).toThrow(
    /box requires image input/
  );
  expect(() =>
    mdPromptJev('text', {
      questions: { where: { type: 'box', instructions: 'region' } },
    })
  ).toThrow(/of type 'box' requires image input/);
  expect(() =>
    mdPromptJev([image], { instructions: 'Itemized?', batchSize: 4 })
  ).toThrow(/batchSize is not supported with image input/);
  expect(() => mdPromptJev([], { instructions: 'Itemized?' })).toThrow(
    /at least one image/
  );
  expect(() =>
    mdPromptJev([image, image], { instructions: 'Itemized?' })
  ).toThrow(/"receipt" is used more than once/);
  expect(() =>
    mdPromptJev([{ ...image, format: 'gif' as 'png' }], {
      instructions: 'Itemized?',
    })
  ).toThrow(/format must be one of png, jpg or jpeg/);
  expect(() =>
    mdPromptJev([{ name: 'x', image: 'not bytes' as unknown as Uint8Array }], {
      instructions: 'Itemized?',
    })
  ).toThrow(/must be a Uint8Array or SQL expression/);
  expect(() =>
    mdPromptJev([image], {
      box: 'region',
      instructions: 'extra',
    } as unknown as MotherDuckPromptJevOptions)
  ).toThrow(/cannot be combined/);
});

test('prompt_jev infers the decoded result type from its options', () => {
  expectTypeOf(mdPromptJev('x', { instructions: 'Refund?' })).toEqualTypeOf<
    SQL<number | null>
  >();
  expectTypeOf(
    mdPromptJev('x', { instructions: 'Team?', choice: ['a', 'b'] })
  ).toEqualTypeOf<SQL<MotherDuckJevChoiceResult | null>>();
  expectTypeOf(
    mdPromptJev('x', { instructions: 'Severity?', score: ['low', 'high'] })
  ).toEqualTypeOf<SQL<MotherDuckJevScoreResult | null>>();
  expectTypeOf(
    mdPromptJev('x', { instructions: 'Features?', multipleChoice: ['api'] })
  ).toEqualTypeOf<SQL<MotherDuckJevMultipleChoiceResult | null>>();
  expectTypeOf(
    mdPromptJev([{ name: 'a', image: sql`b` }], { box: 'region' })
  ).toEqualTypeOf<SQL<MotherDuckJevBoxResult | null>>();
  expectTypeOf(
    mdPromptJev('x', {
      questions: {
        refund: { type: 'noul', instructions: 'Refund?' },
        team: { type: 'choice', instructions: 'Team?', criteria: ['a', 'b'] },
      },
    })
  ).toEqualTypeOf<
    SQL<{ refund: number; team: MotherDuckJevChoiceResult } | null>
  >();
  const widelyTyped: Record<string, MotherDuckJevQuestion> = {
    refund: { type: 'noul', instructions: 'Refund?' },
  };
  expectTypeOf(mdPromptJev('x', { questions: widelyTyped })).toEqualTypeOf<
    SQL<{
      [name: string]:
        | number
        | MotherDuckJevChoiceResult
        | MotherDuckJevScoreResult
        | MotherDuckJevBoxResult;
    } | null>
  >();
  expectTypeOf(mdPromptJev('x', { questions: '{}' })).toEqualTypeOf<
    SQL<Record<string, unknown> | null>
  >();
});

test('prompt_jev sends plain strings as labels when criteria mix both forms', () => {
  const query = dialect.sqlToQuery(sql`
    select ${mdPromptJev(sql`message`, {
      instructions: 'Which features does this request?',
      multipleChoice: [
        { label: 'sso', description: 'Single sign-on' },
        "it's billing",
      ],
    })}
  `);

  expect(query.sql).toContain(
    "multiple_choice := [{label: 'sso', description: 'Single sign-on'}, {label: 'it''s billing', description: NULL::VARCHAR}]"
  );
  expect(() =>
    mdPromptJev(sql`message`, {
      instructions: 'x',
      choice: ['a', 1 as unknown as string],
    })
  ).toThrow(/choice items must be strings or \{ label, description \} objects/);
});

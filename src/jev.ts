import { sql, type SQLWrapper } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql/sql';

export interface MotherDuckJevLabel {
  label: string;
  description?: string | null;
}

export type MotherDuckJevCriteria =
  | readonly string[]
  | readonly MotherDuckJevLabel[];

export type MotherDuckJevQuestion =
  | {
      type: 'noul';
      instructions: string;
      criteria?: MotherDuckJevCriteria;
    }
  | {
      type: 'choice' | 'score';
      instructions: string;
      criteria: MotherDuckJevCriteria;
    };

type JevQuestionOptions = {
  questions: string | Record<string, MotherDuckJevQuestion>;
  instructions?: never;
  choice?: never;
  score?: never;
  noul?: never;
  batchSize?: never;
};

type JevSingleQuestionOptions = {
  questions?: never;
  instructions: string;
  batchSize?: number;
} & (
  | { choice?: never; score?: never; noul?: never }
  | { choice: MotherDuckJevCriteria; score?: never; noul?: never }
  | { choice?: never; score: MotherDuckJevCriteria; noul?: never }
  | { choice?: never; score?: never; noul: MotherDuckJevCriteria }
);

export type MotherDuckPromptJevOptions =
  | JevQuestionOptions
  | JevSingleQuestionOptions;

function constantString(value: string): SQL {
  if (typeof value !== 'string') {
    throw new Error('prompt_jev constant arguments must be strings');
  }
  if (value.includes('\0')) {
    throw new Error('prompt_jev constant arguments cannot contain a NULL byte');
  }
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

function constantCriteria(criteria: MotherDuckJevCriteria, name: string): SQL {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error(`prompt_jev ${name} must be a non-empty array`);
  }

  const values = criteria.map((item: string | MotherDuckJevLabel) => {
    if (typeof item === 'string') {
      return constantString(item);
    }
    if (item === null || typeof item !== 'object') {
      throw new Error(
        `prompt_jev ${name} items must be strings or { label, description } objects`
      );
    }
    if (typeof item.label !== 'string') {
      throw new Error(`prompt_jev ${name} labels must be strings`);
    }

    return sql`{label: ${constantString(item.label)}, description: ${
      item.description == null
        ? sql.raw('NULL')
        : constantString(item.description)
    }}`;
  });

  return sql`[${sql.join(values, sql`, `)}]`;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`prompt_jev ${name} must be a non-empty string`);
  }
  return value;
}

function constantQuestions(
  questions: Record<string, MotherDuckJevQuestion>
): SQL {
  if (
    questions === null ||
    typeof questions !== 'object' ||
    Array.isArray(questions)
  ) {
    throw new Error(
      'prompt_jev questions must be a JSON string or a record of questions'
    );
  }

  const entries = Object.entries(questions);
  if (entries.length === 0) {
    throw new Error('prompt_jev questions must contain at least one question');
  }

  const fields = entries.map(([name, question]) => {
    if (question === null || typeof question !== 'object') {
      throw new Error(`prompt_jev question "${name}" must be an object`);
    }
    const settings = [
      sql`type: ${constantString(
        requireNonEmptyString(question.type, `question "${name}" type`)
      )}`,
      sql`instructions: ${constantString(
        requireNonEmptyString(
          question.instructions,
          `question "${name}" instructions`
        )
      )}`,
    ];
    if (question.criteria !== undefined) {
      settings.push(
        sql`criteria: ${constantCriteria(
          question.criteria,
          `question "${name}" criteria`
        )}`
      );
    } else if (question.type === 'choice' || question.type === 'score') {
      throw new Error(
        `prompt_jev question "${name}" of type '${question.type}' requires criteria`
      );
    }
    return sql`${constantString(name)}: {${sql.join(settings, sql`, `)}}`;
  });
  return sql`{${sql.join(fields, sql`, `)}}`;
}

/**
 * Build prompt_jev with literal question metadata required by MotherDuck's
 * binder. The input remains a bound value or SQL expression.
 */
export function mdPromptJev(
  input: string | SQLWrapper,
  options: MotherDuckPromptJevOptions
): SQL {
  const inputExpression = sql`CAST(${input} AS VARCHAR)`;
  const settings = options as Record<string, unknown>;
  const modes = ['questions', 'choice', 'score', 'noul'].filter(
    (name) => settings[name] !== undefined
  );
  if (
    modes.length > 1 ||
    (modes[0] === 'questions' &&
      (settings.instructions !== undefined || settings.batchSize !== undefined))
  ) {
    throw new Error('prompt_jev question modes cannot be combined');
  }

  if (options.questions !== undefined) {
    if (typeof options.questions === 'string' && !options.questions.trim()) {
      throw new Error('prompt_jev questions JSON must not be empty');
    }
    const questions =
      typeof options.questions === 'string'
        ? sql`${constantString(options.questions)}::JSON`
        : constantQuestions(options.questions);
    return sql`prompt_jev(${inputExpression}, questions := ${questions})`;
  }

  const args: SQL[] = [
    inputExpression,
    constantString(requireNonEmptyString(options.instructions, 'instructions')),
  ];

  if (options.choice !== undefined) {
    args.push(sql`choice := ${constantCriteria(options.choice, 'choice')}`);
  } else if (options.score !== undefined) {
    args.push(sql`score := ${constantCriteria(options.score, 'score')}`);
  } else if (options.noul !== undefined) {
    args.push(sql`noul := ${constantCriteria(options.noul, 'noul')}`);
  }

  if (options.batchSize !== undefined) {
    if (
      !Number.isInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 64
    ) {
      throw new Error('prompt_jev batchSize must be an integer from 1 to 64');
    }
    args.push(sql`batch_size := ${sql.raw(String(options.batchSize))}`);
  }

  return sql`prompt_jev(${sql.join(args, sql`, `)})`;
}

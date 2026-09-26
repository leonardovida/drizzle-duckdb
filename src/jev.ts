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
  if (value.includes('\0')) {
    throw new Error('prompt_jev constant arguments cannot contain a NULL byte');
  }
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

function constantCriteria(criteria: MotherDuckJevCriteria): SQL {
  const values = criteria.map((item) => {
    if (typeof item === 'string') {
      return constantString(item);
    }

    return sql`{label: ${constantString(item.label)}, description: ${
      item.description == null
        ? sql.raw('NULL')
        : constantString(item.description)
    }}`;
  });

  return sql`[${sql.join(values, sql`, `)}]`;
}

function constantQuestions(
  questions: Record<string, MotherDuckJevQuestion>
): SQL {
  const fields = Object.entries(questions).map(([name, question]) => {
    const settings = [
      sql`type: ${constantString(question.type)}`,
      sql`instructions: ${constantString(question.instructions)}`,
    ];
    if (question.criteria !== undefined) {
      settings.push(sql`criteria: ${constantCriteria(question.criteria)}`);
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

  if ('questions' in options) {
    const questions =
      typeof options.questions === 'string'
        ? sql`${constantString(options.questions)}::JSON`
        : constantQuestions(options.questions);
    return sql`prompt_jev(${inputExpression}, questions := ${questions})`;
  }

  const args: SQL[] = [inputExpression, constantString(options.instructions)];

  if (options.choice !== undefined) {
    args.push(sql`choice := ${constantCriteria(options.choice)}`);
  } else if (options.score !== undefined) {
    args.push(sql`score := ${constantCriteria(options.score)}`);
  } else if (options.noul !== undefined) {
    args.push(sql`noul := ${constantCriteria(options.noul)}`);
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

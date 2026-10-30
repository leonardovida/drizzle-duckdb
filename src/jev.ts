import { sql, type SQLWrapper } from 'drizzle-orm';
import { isSQLWrapper, type SQL } from 'drizzle-orm/sql/sql';
import {
  assertUniqueStructKeys,
  constantString,
  requireNonEmptyString,
} from './sql-constants.ts';

const FUNCTION_NAME = 'prompt_jev';

export interface MotherDuckJevLabel {
  label: string;
  description?: string | null;
}

/**
 * Plain strings and `{ label, description }` objects. When a list mixes both,
 * strings become labels without a description, since a SQL list holds one type.
 */
export type MotherDuckJevCriteria = readonly (string | MotherDuckJevLabel)[];

export type MotherDuckJevImageFormat = 'png' | 'jpg' | 'jpeg';

export interface MotherDuckJevImage {
  /** Name the instructions use to refer to the image, in backticks. */
  name: string;
  /** Image bytes, or a SQL expression that yields a BLOB. */
  image: Uint8Array | SQLWrapper;
  /** Still image encoding. MotherDuck assumes `jpg` when omitted. */
  format?: MotherDuckJevImageFormat;
}

/** A text value or expression, or a list of named images. */
export type MotherDuckJevInput =
  | string
  | SQLWrapper
  | readonly MotherDuckJevImage[];

export type MotherDuckJevQuestion =
  | {
      type: 'noul';
      instructions: string;
      criteria?: MotherDuckJevCriteria;
    }
  | {
      type: 'choice';
      instructions: string;
      criteria: MotherDuckJevCriteria;
    }
  | {
      type: 'score';
      instructions: string;
      criteria: MotherDuckJevCriteria;
    }
  | {
      /** Locate a region of an image. Requires image input. */
      type: 'box';
      instructions: string;
      criteria?: never;
    };

export interface MotherDuckJevProbability {
  value: string;
  probability: number;
}

export interface MotherDuckJevChoiceResult {
  choice: string;
  probabilities: MotherDuckJevProbability[];
  confidence: number;
}

export interface MotherDuckJevScoreResult {
  score: number;
  probabilities: (MotherDuckJevProbability & { index: number })[];
  confidence: number;
}

export interface MotherDuckJevMultipleChoiceResult {
  /** Every candidate whose independent probability is above 0.5. */
  choices: string[];
  probabilities: MotherDuckJevProbability[];
}

export interface MotherDuckJevBoxResult {
  /** Edges of the region as fractions of the image size. */
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number;
}

type NoSelectors = {
  choice?: never;
  score?: never;
  noul?: never;
  multipleChoice?: never;
};

type JevQuestionOptions = NoSelectors & {
  questions: string | Record<string, MotherDuckJevQuestion>;
  instructions?: never;
  box?: never;
  /** Rows per request, from 1 to 64. Not allowed with image input. */
  batchSize?: number;
};

type JevBoxOptions = NoSelectors & {
  /** Describe the region to locate. Requires image input. */
  box: string;
  questions?: never;
  instructions?: never;
  batchSize?: never;
};

type JevSingleQuestionOptions = {
  questions?: never;
  box?: never;
  instructions: string;
  /** Rows per request, from 1 to 64. Not allowed with image input. */
  batchSize?: number;
} & (
  | NoSelectors
  | (Omit<NoSelectors, 'choice'> & { choice: MotherDuckJevCriteria })
  | (Omit<NoSelectors, 'score'> & { score: MotherDuckJevCriteria })
  | (Omit<NoSelectors, 'noul'> & { noul: MotherDuckJevCriteria })
  | (Omit<NoSelectors, 'multipleChoice'> & {
      multipleChoice: MotherDuckJevCriteria;
    })
);

export type MotherDuckPromptJevOptions =
  | JevQuestionOptions
  | JevBoxOptions
  | JevSingleQuestionOptions;

type JevQuestionResult<Q> = Q extends { type: 'choice' }
  ? MotherDuckJevChoiceResult
  : Q extends { type: 'score' }
    ? MotherDuckJevScoreResult
    : Q extends { type: 'box' }
      ? MotherDuckJevBoxResult
      : Q extends { type: 'noul' }
        ? number
        : unknown;

/** The decoded value of a prompt_jev call, keyed by the options it was built with. */
export type MotherDuckPromptJevResult<O extends MotherDuckPromptJevOptions> =
  O extends {
    questions: infer Q extends string | Record<string, MotherDuckJevQuestion>;
  }
    ? Q extends string
      ? Record<string, unknown>
      : { [K in keyof Q]: JevQuestionResult<Q[K]> }
    : O extends { box: string }
      ? MotherDuckJevBoxResult
      : O extends { choice: MotherDuckJevCriteria }
        ? MotherDuckJevChoiceResult
        : O extends { score: MotherDuckJevCriteria }
          ? MotherDuckJevScoreResult
          : O extends { multipleChoice: MotherDuckJevCriteria }
            ? MotherDuckJevMultipleChoiceResult
            : number;

const imageFormats = new Set<string>(['png', 'jpg', 'jpeg']);

function constant(value: string): SQL {
  return constantString(value, FUNCTION_NAME);
}

function requireText(value: unknown, name: string): string {
  return requireNonEmptyString(value, name, FUNCTION_NAME);
}

function constantCriteria(criteria: MotherDuckJevCriteria, name: string): SQL {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error(`prompt_jev ${name} must be a non-empty array`);
  }

  for (const item of criteria) {
    if (typeof item === 'string') continue;
    if (item === null || typeof item !== 'object') {
      throw new Error(
        `prompt_jev ${name} items must be strings or { label, description } objects`
      );
    }
    if (typeof item.label !== 'string') {
      throw new Error(`prompt_jev ${name} labels must be strings`);
    }
  }

  // A SQL list holds one type, so plain strings become labels when any item
  // is a label object.
  const labeled = criteria.some((item) => typeof item !== 'string');
  const values = criteria.map((item) => {
    if (!labeled) {
      return constant(item as string);
    }
    const { label, description } =
      typeof item === 'string' ? { label: item, description: null } : item;
    // A bare NULL types the field as "NULL", not VARCHAR.
    return sql`{label: ${constant(label)}, description: ${
      description == null ? sql.raw('NULL::VARCHAR') : constant(description)
    }}`;
  });

  return sql`[${sql.join(values, sql`, `)}]`;
}

function constantQuestions(
  questions: Record<string, MotherDuckJevQuestion>,
  imageInput: boolean
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

  assertUniqueStructKeys(
    entries.map(([name]) => name),
    'question'
  );
  const fields = entries.map(([name, question]) => {
    if (question === null || typeof question !== 'object') {
      throw new Error(`prompt_jev question "${name}" must be an object`);
    }
    const type = requireText(question.type, `question "${name}" type`);
    const settings = [
      sql`type: ${constant(type)}`,
      sql`instructions: ${constant(
        requireText(question.instructions, `question "${name}" instructions`)
      )}`,
    ];
    if (type === 'box') {
      if (!imageInput) {
        throw new Error(
          `prompt_jev question "${name}" of type 'box' requires image input`
        );
      }
      if (question.criteria !== undefined) {
        throw new Error(
          `prompt_jev question "${name}" of type 'box' does not take criteria`
        );
      }
    } else if (question.criteria !== undefined) {
      settings.push(
        sql`criteria: ${constantCriteria(
          question.criteria,
          `question "${name}" criteria`
        )}`
      );
    } else if (type === 'choice' || type === 'score') {
      throw new Error(
        `prompt_jev question "${name}" of type '${type}' requires criteria`
      );
    }
    return sql`${constant(name)}: {${sql.join(settings, sql`, `)}}`;
  });
  return sql`{${sql.join(fields, sql`, `)}}`;
}

function isImageInput(
  input: MotherDuckJevInput
): input is readonly MotherDuckJevImage[] {
  return Array.isArray(input);
}

function imageListInput(images: readonly MotherDuckJevImage[]): SQL {
  if (images.length === 0) {
    throw new Error('prompt_jev image input must contain at least one image');
  }

  // Every list element must have the same STRUCT type, so either all images
  // carry a format or none do.
  const withFormat = images.some((image) => image?.format !== undefined);
  const names = new Set<string>();
  const items = images.map((image, index) => {
    if (image === null || typeof image !== 'object') {
      throw new Error(`prompt_jev image ${index} must be an object`);
    }
    const name = requireText(image.name, `image ${index} name`);
    if (names.has(name)) {
      throw new Error(`prompt_jev image name "${name}" is used more than once`);
    }
    names.add(name);

    const bytes = image.image;
    let value: SQL;
    if (bytes instanceof Uint8Array) {
      value = sql`CAST(${bytes} AS BLOB)`;
    } else if (bytes != null && isSQLWrapper(bytes)) {
      value = sql`${bytes}`;
    } else {
      throw new Error(
        `prompt_jev image "${name}" must be a Uint8Array or SQL expression`
      );
    }

    const fields = [sql`name: ${constant(name)}`, sql`image: ${value}`];
    if (withFormat) {
      const format = image.format ?? 'jpg';
      if (!imageFormats.has(format)) {
        throw new Error(
          `prompt_jev image "${name}" format must be one of png, jpg or jpeg`
        );
      }
      fields.push(sql`format: ${constant(format)}`);
    }
    return sql`{${sql.join(fields, sql`, `)}}`;
  });

  return sql`[${sql.join(items, sql`, `)}]`;
}

function batchSizeArg(
  batchSize: number | undefined,
  imageInput: boolean
): SQL | undefined {
  if (batchSize === undefined) {
    return undefined;
  }
  if (imageInput) {
    throw new Error('prompt_jev batchSize is not supported with image input');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) {
    throw new Error('prompt_jev batchSize must be an integer from 1 to 64');
  }
  return sql`, batch_size := ${sql.raw(String(batchSize))}`;
}

/**
 * Build prompt_jev with literal question metadata required by MotherDuck's
 * binder. The input remains a bound value or SQL expression. Pass a list of
 * named images to classify images or to locate a region with `box`.
 */
export function mdPromptJev<O extends MotherDuckPromptJevOptions>(
  input: MotherDuckJevInput,
  options: O
): SQL<MotherDuckPromptJevResult<O> | null> {
  const settings = options as Record<string, unknown>;
  const modes = [
    'questions',
    'box',
    'choice',
    'score',
    'noul',
    'multipleChoice',
  ].filter((name) => settings[name] !== undefined);
  if (
    modes.length > 1 ||
    (modes[0] === 'questions' && settings.instructions !== undefined) ||
    (modes[0] === 'box' &&
      (settings.instructions !== undefined || settings.batchSize !== undefined))
  ) {
    throw new Error('prompt_jev question modes cannot be combined');
  }

  const imageInput = isImageInput(input);
  const inputExpression = imageInput
    ? imageListInput(input)
    : sql`CAST(${input} AS VARCHAR)`;
  const batchSize = batchSizeArg(options.batchSize, imageInput);

  if (options.questions !== undefined) {
    if (typeof options.questions === 'string' && !options.questions.trim()) {
      throw new Error('prompt_jev questions JSON must not be empty');
    }
    const questions =
      typeof options.questions === 'string'
        ? sql`${constant(options.questions)}::JSON`
        : constantQuestions(options.questions, imageInput);
    return sql`prompt_jev(${inputExpression}, questions := ${questions}${
      batchSize ?? sql``
    })`;
  }

  if (options.box !== undefined) {
    if (!imageInput) {
      throw new Error('prompt_jev box requires image input');
    }
    return sql`prompt_jev(${inputExpression}, box := ${constant(
      requireText(options.box, 'box')
    )})`;
  }

  const args: SQL[] = [
    inputExpression,
    constant(requireText(options.instructions, 'instructions')),
  ];

  if (options.choice !== undefined) {
    args.push(sql`choice := ${constantCriteria(options.choice, 'choice')}`);
  } else if (options.score !== undefined) {
    args.push(sql`score := ${constantCriteria(options.score, 'score')}`);
  } else if (options.noul !== undefined) {
    args.push(sql`noul := ${constantCriteria(options.noul, 'noul')}`);
  } else if (options.multipleChoice !== undefined) {
    args.push(
      sql`multiple_choice := ${constantCriteria(
        options.multipleChoice,
        'multipleChoice'
      )}`
    );
  }

  return sql`prompt_jev(${sql.join(args, sql`, `)}${batchSize ?? sql``})`;
}

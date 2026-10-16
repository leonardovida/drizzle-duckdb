import { sql, type SQLWrapper } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql/sql';
import {
  assertUniqueStructKeys,
  constantString,
  requireNonEmptyString,
} from './sql-constants.ts';

const FUNCTION_NAME = 'prompt';

/** Models MotherDuck documents for prompt(). Other names pass through. */
export type MotherDuckPromptModel =
  | 'gpt-4o-mini'
  | 'gpt-4o'
  | 'gpt-4.1-nano'
  | 'gpt-4.1-mini'
  | 'gpt-4.1'
  | 'gpt-5-nano'
  | 'gpt-5-mini'
  | 'gpt-5'
  | 'gpt-6-luna'
  | (string & {});

export type MotherDuckPromptReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface MotherDuckPromptOptions {
  /** Defaults to `gpt-4o-mini` on MotherDuck. */
  model?: MotherDuckPromptModel;
  /** From 0 to 1. Reasoning models reject it. */
  temperature?: number;
  /** Only for reasoning models. MotherDuck defaults it to `none`. */
  reasoningEffort?: MotherDuckPromptReasoningEffort;
  /** Return a STRUCT. Maps each field name to a DuckDB type such as `VARCHAR`. */
  struct?: Record<string, string>;
  /** Describes `struct` fields for the model. Requires `struct`. */
  structDescr?: Record<string, string>;
  /** Return JSON that follows this JSON Schema. */
  jsonSchema?: string | Record<string, unknown>;
  /** Return a single value of this DuckDB type, such as `INTEGER[]`. */
  returnType?: string;
}

const reasoningEfforts = new Set<string>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function constant(value: string): SQL {
  return constantString(value, FUNCTION_NAME);
}

function constantStruct(
  fields: Record<string, string>,
  name: 'struct' | 'structDescr'
): SQL {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`prompt ${name} must be a record of strings`);
  }
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    throw new Error(`prompt ${name} must contain at least one field`);
  }
  assertUniqueStructKeys(
    entries.map(([field]) => field),
    `prompt ${name} field`
  );
  return sql`{${sql.join(
    entries.map(
      ([field, value]) =>
        sql`${constant(field)}: ${constant(
          requireNonEmptyString(value, `${name} field "${field}"`, 'prompt')
        )}`
    ),
    sql`, `
  )}}`;
}

/**
 * Build MotherDuck prompt() with its settings inlined as constants, which the
 * binder requires. The input remains a bound value or SQL expression. Pass the
 * decoded type as `T` when using `struct`, `jsonSchema` or `returnType`.
 */
export function mdPrompt<T = string>(
  input: string | SQLWrapper,
  options: MotherDuckPromptOptions = {}
): SQL<T | null> {
  const args: SQL[] = [sql`CAST(${input} AS VARCHAR)`];

  if (options.model !== undefined) {
    args.push(
      sql`model := ${constant(requireNonEmptyString(options.model, 'model', FUNCTION_NAME))}`
    );
  }

  if (options.temperature !== undefined) {
    const { temperature } = options;
    if (
      typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 1
    ) {
      throw new Error('prompt temperature must be a number from 0 to 1');
    }
    args.push(sql`temperature := ${sql.raw(String(temperature))}`);
  }

  if (options.reasoningEffort !== undefined) {
    // MotherDuck takes temperature only for non-reasoning models and
    // reasoning_effort only for reasoning models.
    if (options.temperature !== undefined) {
      throw new Error(
        'prompt temperature and reasoningEffort cannot be combined'
      );
    }
    if (!reasoningEfforts.has(options.reasoningEffort)) {
      throw new Error(
        'prompt reasoningEffort must be one of none, minimal, low, medium, high or xhigh'
      );
    }
    args.push(sql`reasoning_effort := ${constant(options.reasoningEffort)}`);
  }

  const outputs = [options.struct, options.jsonSchema, options.returnType];
  if (outputs.filter((output) => output !== undefined).length > 1) {
    throw new Error(
      'prompt struct, jsonSchema and returnType cannot be combined'
    );
  }
  if (options.structDescr !== undefined && options.struct === undefined) {
    throw new Error('prompt structDescr requires struct');
  }

  if (options.struct !== undefined) {
    args.push(sql`struct := ${constantStruct(options.struct, 'struct')}`);
    if (options.structDescr !== undefined) {
      args.push(
        sql`struct_descr := ${constantStruct(options.structDescr, 'structDescr')}`
      );
    }
  } else if (options.jsonSchema !== undefined) {
    const schema =
      typeof options.jsonSchema === 'string'
        ? options.jsonSchema
        : JSON.stringify(options.jsonSchema);
    args.push(
      sql`json_schema := ${constant(
        requireNonEmptyString(schema, 'jsonSchema', FUNCTION_NAME)
      )}`
    );
  } else if (options.returnType !== undefined) {
    args.push(
      sql`return_type := ${constant(
        requireNonEmptyString(options.returnType, 'returnType', FUNCTION_NAME)
      )}`
    );
  }

  return sql`prompt(${sql.join(args, sql`, `)})`;
}

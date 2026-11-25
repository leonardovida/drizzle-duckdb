import { entityKind, is } from 'drizzle-orm/entity';
import { Column } from 'drizzle-orm/column';
import {
  CodecsCollection,
  type Codec,
  type Codecs,
  type ResolvedCodecs,
} from 'drizzle-orm/codecs';
import { PgJson, PgJsonb } from 'drizzle-orm/pg-core';
import { resolvePgTypeAlias } from 'drizzle-orm/pg-core/codecs';
import { sql, type SQLChunk } from 'drizzle-orm/sql/sql';

export const PG_JSON_UNSUPPORTED_MESSAGE =
  "Pg JSON/JSONB columns are not supported in DuckDB. Replace them with duckDbJson() to use DuckDB's native JSON type.";

type Normalize = (value: unknown) => unknown;

/** Apply `normalize` to every item of a nested array, `dimensions` deep. */
function mapArrayItems(normalize: Normalize) {
  const map = (value: unknown, dimensions: number): unknown =>
    dimensions > 0 && Array.isArray(value)
      ? value.map((item) => (item === null ? null : map(item, dimensions - 1)))
      : normalize(value);
  return map;
}

/**
 * A codec that decodes values the way the pg-core column did in drizzle-orm
 * 0.x, before 1.0 moved that decoding out of the columns. It runs after the
 * driver has normalized the node-api value (see sql/result-mapper.ts), and
 * for values of relations, which DuckDB returns as native structs and lists.
 */
function decoding(normalize: Normalize): Codec {
  const normalizeArray = mapArrayItems(normalize);
  return {
    normalize,
    normalizeArray,
    normalizeInJson: normalize,
    normalizeArrayInJson: normalizeArray,
  };
}

const isInfiniteValue = (value: unknown): boolean =>
  value === 'infinity' || value === '-infinity';

const toNumber: Normalize = (value) =>
  typeof value === 'number' ? value : Number(value);
const toBigInt: Normalize = (value) =>
  BigInt(value as string | number | bigint | boolean);
const toText: Normalize = (value) =>
  typeof value === 'string' ? value : String(value);
const parseInteger: Normalize = (value) =>
  typeof value === 'string' ? Number.parseInt(value) : value;
const parseSmallint: Normalize = (value) =>
  typeof value === 'string' ? Number(value) : value;
const parseFloatValue: Normalize = (value) =>
  typeof value === 'string' ? Number.parseFloat(value) : value;
const parseJson: Normalize = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Codecs of the pg-core column types, keyed by their codec name. */
export const duckDbCodecs: Codecs = {
  bigint: decoding(toBigInt),
  'bigint:number': decoding(toNumber),
  'bigint:string': decoding(toText),
  bigserial: decoding(toBigInt),
  'bigserial:number': decoding(toNumber),
  int: decoding(parseInteger),
  serial: decoding(parseInteger),
  smallint: decoding(parseSmallint),
  smallserial: decoding(parseSmallint),
  float4: decoding(parseFloatValue),
  float8: decoding(parseFloatValue),
  numeric: decoding(toText),
  'numeric:number': decoding(toNumber),
  'numeric:bigint': decoding(toBigInt),
  date: decoding((value) =>
    isInfiniteValue(value)
      ? value
      : typeof value === 'string'
        ? new Date(value)
        : value
  ),
  'date:string': decoding((value) =>
    value instanceof Date ? value.toISOString().slice(0, -14) : value
  ),
  timestamp: decoding((value) => {
    if (isInfiniteValue(value) || typeof value !== 'string') return value;
    const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value.trim());
    return new Date(hasZone ? value : `${value}+0000`);
  }),
  timestamptz: decoding((value) =>
    isInfiniteValue(value)
      ? value
      : typeof value === 'string'
        ? new Date(value)
        : value
  ),
  json: decoding(parseJson),
  jsonb: decoding(parseJson),
};

/** How a bound parameter relates to a column. */
export type ParamKind = 'scalar' | 'array';

let paramKindRecording: Map<number, ParamKind> | undefined;

/**
 * Run `build`, which renders a query, and collect the kind of every param
 * bound to a column: 'array' for a pg-core array column, 'scalar' for any
 * other column. Params without a column are not listed. drizzle-orm 1.0 no
 * longer reports query typings, so the codecs record this while rendering.
 */
export function recordParamKinds<T>(build: () => T): {
  result: T;
  kinds: Map<number, ParamKind>;
} {
  const previous = paramKindRecording;
  const kinds = new Map<number, ParamKind>();
  paramKindRecording = kinds;
  try {
    return { result: build(), kinds };
  } finally {
    paramKindRecording = previous;
  }
}

function recordParam(escaped: string, column: Column): void {
  if (!paramKindRecording) return;
  const match = /^\$(\d+)$/.exec(escaped);
  if (!match) return;
  const dimensions = (column as Column & { dimensions?: number }).dimensions;
  paramKindRecording.set(Number(match[1]) - 1, dimensions ? 'array' : 'scalar');
}

function isNumericColumn(column: Column): boolean {
  return column.columnType.startsWith('PgNumeric');
}

/**
 * Codecs for the DuckDB dialect. Every column gets a `castParam` codec, even
 * a custom column without a codec name, so that the session learns which
 * params are bound to a column and which of those to an array column. Pg
 * JSON and JSONB params throw, since DuckDB has its own JSON type.
 * `numeric()` values of relations are read as text, so they keep every digit.
 */
export class DuckDBCodecsCollection extends CodecsCollection {
  static override readonly [entityKind]: string = 'DuckDBCodecsCollection';

  private readonly resolved = new WeakMap<Column, ResolvedCodecs>();

  constructor() {
    super(resolvePgTypeAlias, duckDbCodecs);
  }

  /** @internal */
  codecsOf(column: Column, override?: string): ResolvedCodecs {
    if (override === undefined) {
      const cached = this.resolved.get(column);
      if (cached) return cached;
    }
    const base = (
      CodecsCollection.prototype as unknown as {
        codecsOf(column: Column, override?: string): ResolvedCodecs;
      }
    ).codecsOf.call(this, column, override);
    const resolved = this.extend(column, base);
    if (override === undefined) this.resolved.set(column, resolved);
    return resolved;
  }

  private extend(column: Column, base: ResolvedCodecs): ResolvedCodecs {
    const isPgJson = is(column, PgJson) || is(column, PgJsonb);
    const dimensions =
      (column as Column & { dimensions?: number }).dimensions ?? 0;
    const castParam = (escaped: string): string => {
      if (isPgJson) {
        throw new Error(PG_JSON_UNSUPPORTED_MESSAGE);
      }
      recordParam(escaped, column);
      return escaped;
    };
    const castInJson =
      base.castInJson ??
      (is(column, Column) && isNumericColumn(column)
        ? (name: SQLChunk) =>
            sql`cast(${name} as ${sql.raw(`VARCHAR${'[]'.repeat(dimensions)}`)})`
        : undefined);
    return { ...base, castParam, castInJson };
  }
}

/**
 * AST-based SQL transformer for DuckDB compatibility.
 *
 * Transforms:
 * - Array bounds: array_lower(..., 1), array_upper(..., 1) -> DuckDB expressions
 * - JOIN column qualification: "col" = "col" -> "left"."col" = "right"."col"
 * - generate_series aliases and per arm WITH clauses in set operations
 *
 * Postgres array operators (@>, <@, &&) are native in DuckDB and pass through.
 *
 * Re-printing the AST is lossy (node-sql-parser applies backslash escapes to
 * string literals, misreads IS DISTINCT FROM $1, rounds large negative
 * numbers, prints `- -x` as the comment `--x` and reads ANTI or ASOF as a
 * table alias), so the rewritten SQL is only used when its literals,
 * parameters, numbers and quoted identifiers match the original query and it
 * has no comments.
 *
 * Performance optimizations:
 * - LRU cache for transformed queries (avoids re-parsing identical queries)
 * - Smart heuristics to skip JOIN qualification when not needed
 * - Early exit when no transformation is required
 */

import nodeSqlParser from 'node-sql-parser';
const { Parser } = nodeSqlParser;
import type { AST } from 'node-sql-parser';

import {
  dollarTagAt,
  isEscapeStringAt,
  rewriteArrayBoundsText,
} from './array-bounds-text.ts';
import { transformArrayBounds } from './visitors/array-bounds.ts';
import { qualifyJoinColumns } from './visitors/column-qualifier.ts';
import { rewriteGenerateSeriesAliases } from './visitors/generate-series-alias.ts';
import { hoistUnionWith } from './visitors/union-with-hoister.ts';

const parser = new Parser();

export type TransformResult = {
  sql: string;
  transformed: boolean;
};

// LRU cache for transformed SQL queries
// Key: original SQL, Value: transformed result
const CACHE_SIZE = 500;
// Larger statements are transformed but not kept, so the cache cannot hold
// hundreds of multi-megabyte strings.
const MAX_CACHED_QUERY_LENGTH = 64 * 1024;
const transformCache = new Map<string, TransformResult>();
const conservativeTransformCache = new Map<string, TransformResult>();

function getCachedOrTransform(
  query: string,
  transform: () => TransformResult,
  cache = transformCache
): TransformResult {
  const cached = cache.get(query);
  if (cached) {
    // Move to end for LRU behavior
    cache.delete(query);
    cache.set(query, cached);
    return cached;
  }

  const result = transform();
  if (query.length > MAX_CACHED_QUERY_LENGTH) return result;

  // Add to cache with LRU eviction
  if (cache.size >= CACHE_SIZE) {
    // Delete oldest entry (first key in Map iteration order)
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(query, result);

  return result;
}

const DEBUG_ENV = 'DRIZZLE_DUCKDB_DEBUG_AST';

const ARRAY_BOUNDS_PATTERN = /\barray_(?:lower|upper)\s*\(/i;
const JOIN_PATTERN = /\bjoin\b/i;
const UNION_PATTERN = /\bunion\b/i;
const WITH_PATTERN = /\bwith\b/i;
const INTERSECT_PATTERN = /\bintersect\b/i;
const EXCEPT_PATTERN = /\bexcept\b/i;
const GENERATE_SERIES_PATTERN = /\bgenerate_series\b/i;
const UPDATE_PATTERN = /\bupdate\b/i;
const SET_PATTERN = /\bset\b/i;
const FROM_PATTERN = /\bfrom\b/i;
// Constructs that node-sql-parser re-prints with different meaning.
const MANGLED_PATTERN = /\bis\s+(?:not\s+)?distinct\s+from\b/i;

type SqlTokens = {
  strings: string[];
  params: string[];
  identifiers: string[];
  numbers: string[];
  words: Set<string>;
  /** Unquoted words in order, lower-cased, for keyword sequences. */
  wordSequence: string[];
  comments: number;
};

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Scan SQL with DuckDB lexing rules: '' and "" escapes, backslash escapes
 * only in E'' strings. Returns undefined for unterminated strings,
 * identifiers or comments.
 */
function scanSqlTokens(query: string): SqlTokens | undefined {
  const tokens: SqlTokens = {
    strings: [],
    params: [],
    identifiers: [],
    numbers: [],
    words: new Set(),
    wordSequence: [],
    comments: 0,
  };

  const readQuoted = (start: number, quote: string): number => {
    const backslashEscapes = isEscapeStringAt(query, start);
    let index = start + 1;
    while (index < query.length) {
      if (backslashEscapes && query[index] === '\\') {
        index += 2;
        continue;
      }
      if (query[index] === quote) {
        if (query[index + 1] === quote) {
          index += 2;
          continue;
        }
        return index;
      }
      index += 1;
    }
    return -1;
  };

  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    const rest = query.slice(index);

    if (char === "'" || char === '"') {
      const end = readQuoted(index, char);
      if (end === -1) return undefined;
      const text = query.slice(index + 1, end);
      (char === "'" ? tokens.strings : tokens.identifiers).push(text);
      index = end + 1;
    } else if (rest.startsWith('--')) {
      tokens.comments += 1;
      const end = query.indexOf('\n', index);
      index = end === -1 ? query.length : end + 1;
    } else if (rest.startsWith('/*')) {
      tokens.comments += 1;
      const end = query.indexOf('*/', index + 2);
      if (end === -1) return undefined;
      index = end + 2;
    } else if (char === '$') {
      const param = /^\$\d+/.exec(rest);
      const tag = dollarTagAt(query, index);
      if (param) {
        tokens.params.push(param[0]);
        index += param[0].length;
      } else if (tag) {
        const end = query.indexOf(tag, index + tag.length);
        if (end === -1) return undefined;
        tokens.strings.push(query.slice(index, end + tag.length));
        index = end + tag.length;
      } else {
        index += 1;
      }
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)![0];
      tokens.words.add(word);
      tokens.wordSequence.push(word.toLowerCase());
      index += word.length;
    } else if (NUMBER.test(rest)) {
      const number = NUMBER.exec(rest)![0];
      // The printer writes .5 as 0.5.
      tokens.numbers.push(number.startsWith('.') ? `0${number}` : number);
      index += number.length;
    } else {
      index += 1;
    }
  }

  return tokens;
}

function sameItems(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

// DuckDB join modifiers the parser can read as an alias of the table before
// them, so `t anti join u` is re-printed as `"t" AS "anti" INNER JOIN "u"`.
const JOIN_MODIFIERS = new Set([
  'anti',
  'asof',
  'cross',
  'natural',
  'positional',
  'semi',
]);

const JOIN_SIDES = new Set(['left', 'right', 'full', 'outer', 'inner']);

/**
 * Count each modifier written as a join keyword, such as `anti join` or
 * `natural left join`. Only unquoted words count, so a quoted identifier
 * spelled `"anti"` is not a join.
 */
function countJoinModifiers(words: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  words.forEach((word, index) => {
    if (!JOIN_MODIFIERS.has(word)) return;
    let next = index + 1;
    while (JOIN_SIDES.has(words[next] ?? '')) next += 1;
    if (words[next] === 'join') {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  });
  return counts;
}

/**
 * Check that the re-printed SQL kept every string literal, parameter and
 * number, has no comments and only uses identifiers that already appear in
 * the original query.
 */
function preservesTokens(
  original: string,
  printed: string,
  arrayBoundsTransformed = false
): boolean {
  const before = scanSqlTokens(original);
  const after = scanSqlTokens(printed);
  if (!before || !after) return false;

  if (!sameItems(before.strings, after.strings)) return false;
  if (!sameItems(before.params, after.params)) return false;

  // The parser folds a unary minus into a JavaScript number, which loses
  // precision past 2^53. The array bounds rewrite drops the dimension 1 and
  // adds 0 and 1 of its own, so those two are not counted for it.
  const counted = (numbers: string[]) =>
    arrayBoundsTransformed
      ? numbers.filter((number) => number !== '0' && number !== '1')
      : numbers;
  if (!sameItems(counted(before.numbers), counted(after.numbers))) {
    return false;
  }

  // The printer emits no comments, so one in its output is an operator it
  // ran together, such as `- -x` printed as `--x`.
  if (after.comments > 0) return false;

  // A join modifier the parser read as an alias disappears from the join
  // keywords, and the join silently becomes an INNER JOIN.
  const joinsAfter = countJoinModifiers(after.wordSequence);
  for (const [modifier, count] of countJoinModifiers(before.wordSequence)) {
    if ((joinsAfter.get(modifier) ?? 0) < count) return false;
  }

  const known = new Set([...before.identifiers, ...before.words]);
  // Only compiler-owned aliases may be added. Literal and parameter
  // multiplicities remain exact, including in volatile bound expressions.
  if (arrayBoundsTransformed) {
    known.add('__drizzle_array_length');
  }
  return after.identifiers.every((identifier) => known.has(identifier));
}

// Only UPDATE ... SET ... FROM can have columns to qualify. Plain UPDATE,
// DELETE and ON CONFLICT DO UPDATE statements are left unparsed. Each keyword
// is searched once in order, which stays linear on long statements.
function hasUpdateFrom(query: string): boolean {
  const update = UPDATE_PATTERN.exec(query);
  if (!update) return false;
  const afterUpdate = query.slice(update.index + update[0].length);
  const set = SET_PATTERN.exec(afterUpdate);
  if (!set) return false;
  return FROM_PATTERN.test(afterUpdate.slice(set.index + set[0].length));
}

function debugLog(message: string, payload?: unknown): void {
  if (process?.env?.[DEBUG_ENV]) {
    // eslint-disable-next-line no-console
    console.debug('[duckdb-ast]', message, payload ?? '');
  }
}

export function transformSQL(
  query: string,
  options: { qualifyJoinColumns?: boolean } = {}
): TransformResult {
  const needsArrayTransform = ARRAY_BOUNDS_PATTERN.test(query);
  const needsJoinTransform =
    options.qualifyJoinColumns !== false &&
    (JOIN_PATTERN.test(query) || hasUpdateFrom(query));
  // Set operations are only parsed to hoist a WITH out of an arm.
  const needsUnionTransform =
    WITH_PATTERN.test(query) &&
    (UNION_PATTERN.test(query) ||
      INTERSECT_PATTERN.test(query) ||
      EXCEPT_PATTERN.test(query));
  const needsGenerateSeriesTransform = GENERATE_SERIES_PATTERN.test(query);

  if (
    !needsArrayTransform &&
    !needsJoinTransform &&
    !needsUnionTransform &&
    !needsGenerateSeriesTransform
  ) {
    return { sql: query, transformed: false };
  }

  if (MANGLED_PATTERN.test(query)) {
    debugLog('Query uses a construct the parser cannot re-print; skipping');
    return needsArrayTransform
      ? rewriteRemainingArrayBounds({ sql: query, transformed: false })
      : { sql: query, transformed: false };
  }

  // Use cache for repeated queries
  return getCachedOrTransform(
    query,
    () => {
      const result = transformWithAst(query, {
        needsArrayTransform,
        needsJoinTransform,
        needsUnionTransform,
        needsGenerateSeriesTransform,
      });
      return needsArrayTransform ? rewriteRemainingArrayBounds(result) : result;
    },
    options.qualifyJoinColumns === false
      ? conservativeTransformCache
      : transformCache
  );
}

/**
 * Rewrite array bounds calls the AST pass left behind, because the parser
 * could not read the statement, the re-print guard rejected it, or the call
 * sat where the visitor does not walk.
 */
function rewriteRemainingArrayBounds(result: TransformResult): TransformResult {
  if (!ARRAY_BOUNDS_PATTERN.test(result.sql)) return result;
  const sql = rewriteArrayBoundsText(result.sql);
  return sql === result.sql ? result : { sql, transformed: true };
}

function transformWithAst(
  query: string,
  {
    needsArrayTransform,
    needsJoinTransform,
    needsUnionTransform,
    needsGenerateSeriesTransform,
  }: {
    needsArrayTransform: boolean;
    needsJoinTransform: boolean;
    needsUnionTransform: boolean;
    needsGenerateSeriesTransform: boolean;
  }
): TransformResult {
  try {
    const ast = parser.astify(query, { database: 'PostgreSQL' });

    let transformed = false;
    let arrayBoundsTransformed = false;

    if (needsArrayTransform) {
      arrayBoundsTransformed = transformArrayBounds(ast);
      transformed = arrayBoundsTransformed || transformed;
    }

    // Before join qualification, so `ON e.n = gs` is already gs.generate_series
    // and is not qualified as a column of another source.
    if (needsGenerateSeriesTransform) {
      transformed = rewriteGenerateSeriesAliases(ast) || transformed;
    }

    if (needsJoinTransform) {
      transformed = qualifyJoinColumns(ast) || transformed;
    }

    if (needsUnionTransform) {
      transformed = hoistUnionWith(ast) || transformed;
    }

    if (!transformed) {
      debugLog('AST parsed but no transformation applied', {
        join: needsJoinTransform,
      });
      return { sql: query, transformed: false };
    }

    const transformedSql = parser.sqlify(ast, { database: 'PostgreSQL' });

    if (!preservesTokens(query, transformedSql, arrayBoundsTransformed)) {
      debugLog('Re-printed SQL changed literals or identifiers; skipping', {
        sql: transformedSql,
      });
      return { sql: query, transformed: false };
    }

    return { sql: transformedSql, transformed: true };
  } catch (err) {
    debugLog('AST transform failed; returning original SQL', {
      error: (err as Error).message,
    });
    return { sql: query, transformed: false };
  }
}

/**
 * Clear the transformation cache. Useful for testing or memory management.
 */
export function clearTransformCache(): void {
  transformCache.clear();
  conservativeTransformCache.clear();
}

/**
 * Get current cache statistics for monitoring.
 */
export function getTransformCacheStats(
  options: { qualifyJoinColumns?: boolean } = {}
): { size: number; maxSize: number } {
  const cache =
    options.qualifyJoinColumns === false
      ? conservativeTransformCache
      : transformCache;
  return { size: cache.size, maxSize: CACHE_SIZE };
}

export { transformArrayBounds } from './visitors/array-bounds.ts';
export { qualifyJoinColumns } from './visitors/column-qualifier.ts';
export { rewriteGenerateSeriesAliases } from './visitors/generate-series-alias.ts';
export { hoistUnionWith } from './visitors/union-with-hoister.ts';

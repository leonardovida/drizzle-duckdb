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
 * string literals and misreads IS DISTINCT FROM $1), so the rewritten SQL is
 * only used when its literals, parameters and quoted identifiers match the
 * original query.
 *
 * Performance optimizations:
 * - LRU cache for transformed queries (avoids re-parsing identical queries)
 * - Smart heuristics to skip JOIN qualification when not needed
 * - Early exit when no transformation is required
 */

import nodeSqlParser from 'node-sql-parser';
const { Parser } = nodeSqlParser;
import type { AST } from 'node-sql-parser';

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
  words: Set<string>;
};

/**
 * Scan SQL with DuckDB lexing rules: '' and "" escapes, no backslash escapes.
 * Returns undefined for unterminated strings, identifiers or comments.
 */
function scanSqlTokens(query: string): SqlTokens | undefined {
  const tokens: SqlTokens = {
    strings: [],
    params: [],
    identifiers: [],
    words: new Set(),
  };

  const readQuoted = (start: number, quote: string): number => {
    let index = start + 1;
    while (index < query.length) {
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
      const end = query.indexOf('\n', index);
      index = end === -1 ? query.length : end + 1;
    } else if (rest.startsWith('/*')) {
      const end = query.indexOf('*/', index + 2);
      if (end === -1) return undefined;
      index = end + 2;
    } else if (char === '$') {
      const param = /^\$\d+/.exec(rest);
      const tag = /^\$[A-Za-z_]*\$/.exec(rest);
      if (param) {
        tokens.params.push(param[0]);
        index += param[0].length;
      } else if (tag) {
        const end = query.indexOf(tag[0], index + tag[0].length);
        if (end === -1) return undefined;
        tokens.strings.push(query.slice(index, end + tag[0].length));
        index = end + tag[0].length;
      } else {
        index += 1;
      }
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)![0];
      tokens.words.add(word);
      index += word.length;
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

/**
 * Check that the re-printed SQL kept every string literal and parameter and
 * only uses identifiers that already appear in the original query.
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
  const needsUnionTransform =
    UNION_PATTERN.test(query) ||
    INTERSECT_PATTERN.test(query) ||
    EXCEPT_PATTERN.test(query);
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
    return { sql: query, transformed: false };
  }

  // Use cache for repeated queries
  return getCachedOrTransform(
    query,
    () => {
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
    },
    options.qualifyJoinColumns === false
      ? conservativeTransformCache
      : transformCache
  );
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

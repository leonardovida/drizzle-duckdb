/**
 * AST-based SQL transformer for DuckDB compatibility.
 *
 * Transforms:
 * - Array operators: @>, <@, && -> array_has_all(), array_has_any()
 * - JOIN column qualification: "col" = "col" -> "left"."col" = "right"."col"
 *
 * Performance optimizations:
 * - LRU cache for transformed queries (avoids re-parsing identical queries)
 * - Smart heuristics to skip JOIN qualification when not needed
 * - Early exit when no transformation is required
 */

import nodeSqlParser from 'node-sql-parser';
const { Parser } = nodeSqlParser;
import type { AST } from 'node-sql-parser';

import { transformArrayOperators } from './visitors/array-operators.ts';
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

function getCachedOrTransform(
  query: string,
  transform: () => TransformResult
): TransformResult {
  const cached = transformCache.get(query);
  if (cached) {
    // Move to end for LRU behavior
    transformCache.delete(query);
    transformCache.set(query, cached);
    return cached;
  }

  const result = transform();

  // Add to cache with LRU eviction
  if (transformCache.size >= CACHE_SIZE) {
    // Delete oldest entry (first key in Map iteration order)
    const oldestKey = transformCache.keys().next().value;
    if (oldestKey) {
      transformCache.delete(oldestKey);
    }
  }
  transformCache.set(query, result);

  return result;
}

const DEBUG_ENV = 'DRIZZLE_DUCKDB_DEBUG_AST';

const ARRAY_OPERATOR_PATTERN = /@>|<@|&&/;
const JOIN_PATTERN = /\bjoin\b/i;
const UNION_PATTERN = /\bunion\b/i;
const INTERSECT_PATTERN = /\bintersect\b/i;
const EXCEPT_PATTERN = /\bexcept\b/i;
const GENERATE_SERIES_PATTERN = /\bgenerate_series\b/i;
const UPDATE_PATTERN = /\bupdate\b/i;
const DELETE_PATTERN = /\bdelete\b/i;

function hasJoin(query: string): boolean {
  return JOIN_PATTERN.test(query);
}

function debugLog(message: string, payload?: unknown): void {
  if (process?.env?.[DEBUG_ENV]) {
    // eslint-disable-next-line no-console
    console.debug('[duckdb-ast]', message, payload ?? '');
  }
}

export function transformSQL(query: string): TransformResult {
  const needsArrayTransform =
    ARRAY_OPERATOR_PATTERN.test(query);
  const needsJoinTransform =
    hasJoin(query) || UPDATE_PATTERN.test(query) || DELETE_PATTERN.test(query);
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

  // Use cache for repeated queries
  return getCachedOrTransform(query, () => {
    try {
      const ast = parser.astify(query, { database: 'PostgreSQL' });

      let transformed = false;

      if (needsArrayTransform) {
        transformed = transformArrayOperators(ast) || transformed;
      }

      if (needsJoinTransform) {
        transformed = qualifyJoinColumns(ast) || transformed;
      }

      if (needsGenerateSeriesTransform) {
        transformed = rewriteGenerateSeriesAliases(ast) || transformed;
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

      return { sql: transformedSql, transformed: true };
    } catch (err) {
      debugLog('AST transform failed; returning original SQL', {
        error: (err as Error).message,
      });
      return { sql: query, transformed: false };
    }
  });
}

/**
 * Clear the transformation cache. Useful for testing or memory management.
 */
export function clearTransformCache(): void {
  transformCache.clear();
}

/**
 * Get current cache statistics for monitoring.
 */
export function getTransformCacheStats(): { size: number; maxSize: number } {
  return { size: transformCache.size, maxSize: CACHE_SIZE };
}

export function needsTransformation(query: string): boolean {
  return (
    ARRAY_OPERATOR_PATTERN.test(query) ||
    JOIN_PATTERN.test(query) ||
    UNION_PATTERN.test(query) ||
    INTERSECT_PATTERN.test(query) ||
    EXCEPT_PATTERN.test(query) ||
    GENERATE_SERIES_PATTERN.test(query) ||
    UPDATE_PATTERN.test(query) ||
    DELETE_PATTERN.test(query)
  );
}

export { transformArrayOperators } from './visitors/array-operators.ts';
export { qualifyJoinColumns } from './visitors/column-qualifier.ts';
export { rewriteGenerateSeriesAliases } from './visitors/generate-series-alias.ts';
export { hoistUnionWith } from './visitors/union-with-hoister.ts';

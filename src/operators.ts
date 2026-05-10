/**
 * DuckDB-native array operators. Generate DuckDB-compatible SQL directly
 * without query rewriting.
 */

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { buildListLiteral } from './columns.ts';

type ArrayPredicateValue<T> = T[] | SQLWrapper;

function normalizeArrayPredicateValue<T>(
  values: ArrayPredicateValue<T>
): SQL | SQLWrapper {
  return Array.isArray(values) ? buildListLiteral(values) : values;
}

export function arrayHasAll<T>(
  column: SQLWrapper,
  values: ArrayPredicateValue<T>
): SQL {
  const rhs = normalizeArrayPredicateValue(values);
  return sql`array_has_all(${column}, ${rhs})`;
}

export function arrayHasAny<T>(
  column: SQLWrapper,
  values: ArrayPredicateValue<T>
): SQL {
  const rhs = normalizeArrayPredicateValue(values);
  return sql`array_has_any(${column}, ${rhs})`;
}

export function arrayContainedBy<T>(
  column: SQLWrapper,
  values: ArrayPredicateValue<T>
): SQL {
  const lhs = normalizeArrayPredicateValue(values);
  return sql`array_has_all(${lhs}, ${column})`;
}

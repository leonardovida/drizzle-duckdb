import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql/sql';

/**
 * Inline a string as a SQL literal. MotherDuck AI functions read some
 * arguments at bind time and reject bound parameters there.
 */
export function constantString(value: string, functionName: string): SQL {
  if (typeof value !== 'string') {
    throw new Error(`${functionName} constant arguments must be strings`);
  }
  if (value.includes('\0')) {
    throw new Error(
      `${functionName} constant arguments cannot contain a NULL byte`
    );
  }
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

/** DuckDB STRUCT field names are case-insensitive, so `a` and `A` collide. */
export function assertUniqueStructKeys(
  keys: readonly string[],
  kind: string
): void {
  const seen = new Map<string, string>();
  for (const key of keys) {
    const previous = seen.get(key.toLowerCase());
    if (previous !== undefined) {
      throw new Error(
        `${kind} names "${previous}" and "${key}" differ only in case, which DuckDB treats as the same STRUCT field`
      );
    }
    seen.set(key.toLowerCase(), key);
  }
}

export function requireNonEmptyString(
  value: unknown,
  name: string,
  functionName: string
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${functionName} ${name} must be a non-empty string`);
  }
  return value;
}

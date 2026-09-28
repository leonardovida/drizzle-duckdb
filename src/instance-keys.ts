import type { DuckDBInstance } from '@duckdb/node-api';
import { resolve } from 'node:path';

// drizzle(path) shares one database per path through DuckDBInstance.fromCache,
// but every call returns a new DuckDBInstance wrapper. This records which
// database a wrapper points at, so migrate() can queue calls per database.
const databaseKeys = new WeakMap<DuckDBInstance, string>();

/** The key of the database behind `path`, or undefined for `:memory:`. */
function databaseKeyForPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (
    trimmed === '' ||
    trimmed === ':memory:' ||
    trimmed.startsWith(':memory:')
  ) {
    return undefined;
  }
  // md:, s3:// and other URLs are keys as written. Local paths are resolved.
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)
    ? trimmed
    : resolve(trimmed);
}

export function rememberDatabaseKey(
  instance: DuckDBInstance,
  path: string
): void {
  const key = databaseKeyForPath(path);
  if (key !== undefined) {
    databaseKeys.set(instance, key);
  }
}

export function databaseKeyOf(instance: DuckDBInstance): string | undefined {
  return databaseKeys.get(instance);
}

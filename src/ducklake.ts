import type { DuckDBConnection } from '@duckdb/node-api';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { isSQLWrapper, type SQL } from 'drizzle-orm/sql/sql';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DuckDBConnectionPool, DuckDBExecutionClient } from './client.ts';
import {
  resolvePoolSize,
  type DuckDBPoolConfig,
  type PoolPreset,
} from './pool.ts';

export interface DuckLakeAttachOptions {
  createIfNotExists?: boolean;
  dataInliningRowLimit?: number;
  dataPath?: string;
  encrypted?: boolean;
  /**
   * @deprecated DuckLake has no `META_PARAMETER_NAME` option, so this setting
   * always failed the ATTACH. Setting it now throws. Use `metaParameters`.
   */
  metaParameterName?: string;
  /**
   * Options passed to the metadata catalog. Each entry becomes
   * `META_<KEY> 'value'`, so `{ type: 'duckdb' }` emits `META_TYPE 'duckdb'`.
   */
  metaParameters?: Record<string, string>;
  metadataCatalog?: string;
  overrideDataPath?: boolean;
  readOnly?: boolean;
}

export interface DuckLakeConfig {
  catalog: string;
  alias?: string;
  use?: boolean;
  install?: boolean;
  load?: boolean;
  attachOptions?: DuckLakeAttachOptions;
}

export interface NormalizedDuckLakeConfig {
  catalog: string;
  alias: string;
  use: boolean;
  install: boolean;
  load: boolean;
  attachOptions?: DuckLakeAttachOptions;
}

export interface DuckLakePoolResolution {
  poolSize: number | false;
  resolvedPoolSize: number | false;
  isLocalCatalog: boolean;
  hasPoolSetting: boolean;
}

const DEFAULT_ALIAS = 'ducklake';
const DUCKLAKE_PREFIX = 'ducklake:';
// DuckDB matches the scheme without regard to case, as in 'DUCKLAKE:meta.db'.
const DUCKLAKE_PREFIX_PATTERN = /^ducklake:/i;
const DUCKLAKE_ATTACH_OPTION_NAMES = {
  createIfNotExists: 'CREATE_IF_NOT_EXISTS',
  dataInliningRowLimit: 'DATA_INLINING_ROW_LIMIT',
  dataPath: 'DATA_PATH',
  encrypted: 'ENCRYPTED',
  metadataCatalog: 'METADATA_CATALOG',
  overrideDataPath: 'OVERRIDE_DATA_PATH',
  readOnly: 'READ_ONLY',
} as const satisfies Record<
  Exclude<keyof DuckLakeAttachOptions, 'metaParameterName' | 'metaParameters'>,
  string
>;
const META_PARAMETER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteString(value: string): string {
  return `'${escapeSqlString(value)}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isDuckLakeUri(catalog: string): boolean {
  return DUCKLAKE_PREFIX_PATTERN.test(catalog);
}

function stripDuckLakePrefix(catalog: string): string {
  const trimmed = catalog.trim();
  return isDuckLakeUri(trimmed)
    ? trimmed.slice(DUCKLAKE_PREFIX.length).trim()
    : trimmed;
}

/**
 * DuckDB drops `file://` from a path but does not decode it, so a URL with
 * `%20` names a file that does not exist. Send the decoded local path.
 */
function fileUrlToLocalPath(catalog: string): string {
  if (!/^file:/i.test(catalog)) {
    return catalog;
  }
  try {
    return fileURLToPath(catalog);
  } catch {
    return catalog;
  }
}

export function normalizeDuckLakeConfig(
  config: DuckLakeConfig
): NormalizedDuckLakeConfig {
  if (typeof config.catalog !== 'string' || !config.catalog.trim()) {
    throw new Error('DuckLake config requires a catalog');
  }

  return {
    catalog: `${DUCKLAKE_PREFIX}${fileUrlToLocalPath(
      stripDuckLakePrefix(config.catalog)
    )}`,
    alias: config.alias?.trim() || DEFAULT_ALIAS,
    use: config.use ?? true,
    install: config.install ?? false,
    load: config.load ?? false,
    attachOptions: config.attachOptions,
  };
}

function optionValueToSql(
  key: string,
  value: string | number | boolean
): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `DuckLake attach option ${key} must be a non-negative integer, got ${value}`
      );
    }
    return String(value);
  }
  return quoteString(value);
}

function buildMetaParametersSql(
  metaParameters: Record<string, string> | undefined
): string[] {
  if (metaParameters === undefined) {
    return [];
  }

  return Object.entries(metaParameters).map(([key, value]) => {
    if (!META_PARAMETER_KEY.test(key)) {
      throw new Error(
        `DuckLake metaParameters key "${key}" must match ${META_PARAMETER_KEY.source}`
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `DuckLake metaParameters value for "${key}" must be a string`
      );
    }
    return `META_${key.toUpperCase()} ${quoteString(value)}`;
  });
}

function buildDuckLakeAttachOptionsSql(
  attachOptions?: DuckLakeAttachOptions
): string[] {
  if (!attachOptions) {
    return [];
  }

  if (
    attachOptions.metaParameterName !== undefined &&
    attachOptions.metaParameterName !== ''
  ) {
    throw new Error(
      "DuckLake attachOptions.metaParameterName is not supported because DuckLake has no META_PARAMETER_NAME option. Use metaParameters instead, for example metaParameters: { type: 'duckdb' } for META_TYPE 'duckdb'."
    );
  }

  const options: string[] = [];

  for (const [key, optionName] of Object.entries(
    DUCKLAKE_ATTACH_OPTION_NAMES
  ) as [keyof typeof DUCKLAKE_ATTACH_OPTION_NAMES, string][]) {
    const value = attachOptions[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string' && value.length === 0) {
      continue;
    }
    // DuckDB's ATTACH options use `NAME value`; `NAME=value` is a parser error.
    options.push(`${optionName} ${optionValueToSql(key, value)}`);
  }

  options.push(...buildMetaParametersSql(attachOptions.metaParameters));

  return options;
}

function buildNormalizedDuckLakeAttachSql(
  config: NormalizedDuckLakeConfig
): string {
  const options = buildDuckLakeAttachOptionsSql(config.attachOptions);

  // Pooled connections share one DuckDB instance and its attached catalogs.
  // Each new connection re-runs setup, so the attach must be idempotent.
  const attachSql = [
    `ATTACH IF NOT EXISTS ${quoteString(config.catalog)} AS ${quoteIdentifier(
      config.alias
    )}`,
  ];

  if (options.length > 0) {
    attachSql.push(`(${options.join(', ')})`);
  }

  return attachSql.join(' ');
}

export function buildDuckLakeAttachSql(config: DuckLakeConfig): string {
  return buildNormalizedDuckLakeAttachSql(normalizeDuckLakeConfig(config));
}

function resolveLocalCatalogPath(catalog: string): string {
  let path = catalog.trim();
  if (/^duckdb:/i.test(path)) {
    path = path.slice('duckdb:'.length);
  }
  if (path === ':memory:') {
    return path;
  }
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      path = path.slice('file:'.length);
    }
  }
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    path = homedir() + path.slice(1);
  }
  return resolve(path);
}

function isSameLocalCatalog(attachedPath: string, catalog: string): boolean {
  if (attachedPath.trim() === catalog) {
    return true;
  }
  return (
    isDuckDbFileCatalog(attachedPath) &&
    resolveLocalCatalogPath(attachedPath) === resolveLocalCatalogPath(catalog)
  );
}

/**
 * ATTACH IF NOT EXISTS does nothing when the alias already names any
 * database, including the main database file or another DuckLake catalog.
 * Check what the alias points at so writes do not land in the wrong place.
 * duckdb_databases() reports a secret-based or remote catalog by its resolved
 * metadata path, so only local file catalogs get a path comparison.
 */
async function assertDuckLakeAttached(
  connection: DuckDBConnection,
  config: NormalizedDuckLakeConfig
): Promise<void> {
  const reader = await connection.runAndReadAll(
    'select type, path from duckdb_databases() where lower(database_name) = lower($1)',
    [config.alias]
  );
  const row = reader.getRowObjects()[0] as
    | { type?: unknown; path?: unknown }
    | undefined;
  const catalog = stripDuckLakePrefix(config.catalog);
  const alias = quoteIdentifier(config.alias);

  if (!row) {
    throw new Error(
      `DuckLake catalog '${catalog}' was not attached as ${alias}.`
    );
  }

  const attachedPath =
    typeof row.path === 'string' && row.path.length > 0 ? row.path : undefined;

  if (row.type !== 'ducklake') {
    throw new Error(
      `DuckLake alias ${alias} is already used by a ${String(row.type)} database${
        attachedPath ? ` at '${attachedPath}'` : ''
      }, so catalog '${catalog}' was not attached. Set ducklake.alias to a different name.`
    );
  }

  if (
    attachedPath !== undefined &&
    isDuckDbFileCatalog(catalog) &&
    !isSameLocalCatalog(attachedPath, catalog)
  ) {
    throw new Error(
      `DuckLake alias ${alias} is already attached to catalog '${attachedPath}', so catalog '${catalog}' was not attached. Use a different ducklake.alias for each catalog.`
    );
  }
}

async function configureNormalizedDuckLake(
  connection: DuckDBConnection,
  config: NormalizedDuckLakeConfig
): Promise<void> {
  if (config.install) {
    await connection.run('INSTALL ducklake');
  }

  if (config.load) {
    await connection.run('LOAD ducklake');
  }

  await connection.run(buildNormalizedDuckLakeAttachSql(config));
  await assertDuckLakeAttached(connection, config);

  if (config.use) {
    await connection.run(`USE ${quoteIdentifier(config.alias)}`);
  }
}

export async function configureDuckLake(
  connection: DuckDBConnection,
  config: DuckLakeConfig
): Promise<void> {
  await configureNormalizedDuckLake(
    connection,
    normalizeDuckLakeConfig(config)
  );
}

/**
 * Returns a per-connection setup hook for connections that share one DuckDB
 * instance. Concurrent ATTACH IF NOT EXISTS calls can both miss the existing
 * catalog, so setup runs one connection at a time.
 */
export function createDuckLakeConnectionSetup(
  config: DuckLakeConfig
): (connection: DuckDBConnection) => Promise<void> {
  const normalized = normalizeDuckLakeConfig(config);
  let tail: Promise<void> = Promise.resolve();

  return (connection) => {
    const run = tail.then(() =>
      configureNormalizedDuckLake(connection, normalized)
    );
    tail = run.catch(() => undefined);
    return run;
  };
}

function isDuckDBConnection(
  connection: DuckDBExecutionClient
): connection is DuckDBConnection {
  return typeof (connection as DuckDBConnection).run === 'function';
}

export function wrapDuckLakePool(
  pool: DuckDBConnectionPool,
  config: DuckLakeConfig
): DuckDBConnectionPool {
  const configuredConnections = new WeakSet<DuckDBConnection>();
  const setupConnection = createDuckLakeConnectionSetup(config);
  const poolWithSize = pool as unknown as { size?: number };
  const size =
    typeof poolWithSize.size === 'number' ? poolWithSize.size : undefined;

  const wrapped: DuckDBConnectionPool & { size?: number } = {
    async acquire() {
      const connection = await pool.acquire();
      if (!isDuckDBConnection(connection)) {
        await pool.release(connection);
        throw new Error(
          'DuckLake configuration requires an @duckdb/node-api connection pool and cannot be used with pg_duckdb clients.'
        );
      }

      if (configuredConnections.has(connection)) {
        return connection;
      }

      try {
        await setupConnection(connection);
        configuredConnections.add(connection);
        return connection;
      } catch (error) {
        try {
          await pool.release(connection);
        } catch {
          // Preserve the original configuration error when cleanup also fails.
        }
        throw error;
      }
    },
    release(connection) {
      return pool.release(connection);
    },
    close: pool.close?.bind(pool),
  };

  // Keep the pool's counters, such as stats() from createDuckDBConnectionPool.
  const stats = (pool as { stats?: unknown }).stats;
  if (typeof stats === 'function') {
    (wrapped as { stats?: unknown }).stats = stats.bind(pool);
  }

  if (size !== undefined) {
    wrapped.size = size;
  }

  return wrapped;
}

/**
 * Reports whether a DuckLake catalog is a local DuckDB file. `duckdb:` and
 * `file:` catalogs and strings without a scheme that look like a path are
 * local. Other schemes such as `md:`, `s3:` or `postgres:` are not. DuckLake
 * reads a bare name such as `my_lake` as a secret name, so it is not treated as
 * a local file.
 */
export function isDuckDbFileCatalog(catalog: string): boolean {
  const trimmed = catalog.trim();
  if (!trimmed) return false;

  if (trimmed === ':memory:') return true;
  if (isDuckLakeUri(trimmed)) {
    return isDuckDbFileCatalog(trimmed.slice(DUCKLAKE_PREFIX.length));
  }
  // A Windows drive letter looks like a one letter URI scheme.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (/^(duckdb|file):/i.test(trimmed)) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return false;

  return /[./\\~]/.test(trimmed);
}

export function resolveDuckLakePoolSize(
  poolSetting: DuckDBPoolConfig | PoolPreset | false | undefined,
  ducklakeConfig: DuckLakeConfig | undefined
): DuckLakePoolResolution {
  const hasPoolSetting = poolSetting !== undefined;
  const resolvedPoolSize = resolvePoolSize(poolSetting);
  const isLocalCatalog =
    ducklakeConfig !== undefined
      ? isDuckDbFileCatalog(normalizeDuckLakeConfig(ducklakeConfig).catalog)
      : false;
  const poolSize = !hasPoolSetting && isLocalCatalog ? 1 : resolvedPoolSize;

  return {
    poolSize,
    resolvedPoolSize,
    isLocalCatalog,
    hasPoolSetting,
  };
}

export interface DuckLakeMergeAdjacentFilesOptions {
  /** Only compact this table. */
  table?: string | SQLWrapper;
  /** Schema of `table`. */
  schema?: string | SQLWrapper;
  minFileSize?: number | bigint | SQLWrapper;
  maxFileSize?: number | bigint | SQLWrapper;
  maxCompactedFiles?: number | bigint | SQLWrapper;
  /**
   * Only merge files written at or after this time. MotherDuck DuckLake
   * supports it. The DuckLake extension that ships for DuckDB 1.5.6 does not.
   */
  newerThan?: Date | string | SQLWrapper;
  /** Only merge files written before this time. Same support as `newerThan`. */
  olderThan?: Date | string | SQLWrapper;
}

/** One row per compacted table. DuckLake for DuckDB 1.4 returns no rows. */
export type DuckLakeMergeAdjacentFilesRow = {
  schema_name: string;
  table_name: string;
  files_processed: number | bigint;
  files_created: number | bigint;
};

function fileSizeArg(
  value: number | bigint | SQLWrapper | undefined,
  name: string,
  minimum: 0 | 1 = 1
): SQLWrapper | undefined {
  if (value === undefined || isSQLWrapper(value)) {
    return value;
  }
  if (
    (typeof value === 'number' &&
      (!Number.isSafeInteger(value) || value < minimum)) ||
    (typeof value === 'bigint' && value < BigInt(minimum)) ||
    (typeof value !== 'number' && typeof value !== 'bigint')
  ) {
    throw new Error(
      `ducklake_merge_adjacent_files ${name} must be an integer of at least ${minimum}`
    );
  }
  return sql`CAST(${sql.param(value)} AS UBIGINT)`;
}

/**
 * Only instants with an explicit zone compare the same in JS and DuckDB. The
 * zone must follow a time, so the day in a date-only string such as
 * '2024-01-01' is not read as a UTC offset.
 */
function comparableInstant(value: Date | string): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  return /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(
    value.trim()
  )
    ? new Date(value).getTime()
    : undefined;
}

function timestampArg(
  value: Date | string | SQLWrapper | undefined,
  name: string
): SQLWrapper | undefined {
  if (value === undefined || isSQLWrapper(value)) {
    return value;
  }
  if (
    value instanceof Date
      ? Number.isNaN(value.getTime())
      : typeof value !== 'string'
  ) {
    throw new Error(
      `ducklake_merge_adjacent_files ${name} must be a valid Date or timestamp string`
    );
  }
  return sql`CAST(${sql.param(value instanceof Date ? value.toISOString() : value)} AS TIMESTAMPTZ)`;
}

/**
 * Build `ducklake_merge_adjacent_files` to compact small adjacent data files.
 * Use it as a table source, as in `select * from ${duckLakeMergeAdjacentFiles('lake')}`.
 */
export function duckLakeMergeAdjacentFiles(
  catalog: string | SQLWrapper,
  options: DuckLakeMergeAdjacentFilesOptions = {}
): SQL {
  if (options.schema !== undefined && options.table === undefined) {
    throw new Error('ducklake_merge_adjacent_files schema requires table');
  }
  const { newerThan, olderThan, minFileSize, maxFileSize } = options;
  if (
    newerThan !== undefined &&
    olderThan !== undefined &&
    !isSQLWrapper(newerThan) &&
    !isSQLWrapper(olderThan) &&
    // Zone-less strings follow the DuckDB session TimeZone, so leave them
    // to the server.
    (comparableInstant(newerThan) ?? Number.NaN) >=
      (comparableInstant(olderThan) ?? Number.NaN)
  ) {
    throw new Error(
      'ducklake_merge_adjacent_files newerThan must be earlier than olderThan'
    );
  }
  if (
    (typeof minFileSize === 'number' || typeof minFileSize === 'bigint') &&
    (typeof maxFileSize === 'number' || typeof maxFileSize === 'bigint') &&
    BigInt(maxFileSize) <= BigInt(minFileSize)
  ) {
    throw new Error(
      'ducklake_merge_adjacent_files maxFileSize must be greater than minFileSize'
    );
  }

  const args: SQL[] = [sql`${catalog}`];
  if (options.table !== undefined) {
    args.push(sql`${options.table}`);
  }
  const named: [string, SQLWrapper | undefined][] = [
    [
      'schema',
      options.schema === undefined ? undefined : sql`${options.schema}`,
    ],
    ['min_file_size', fileSizeArg(minFileSize, 'minFileSize', 0)],
    ['max_file_size', fileSizeArg(maxFileSize, 'maxFileSize')],
    [
      'max_compacted_files',
      fileSizeArg(options.maxCompactedFiles, 'maxCompactedFiles'),
    ],
    ['newer_than', timestampArg(newerThan, 'newerThan')],
    ['older_than', timestampArg(olderThan, 'olderThan')],
  ];
  for (const [name, value] of named) {
    if (value !== undefined) {
      args.push(sql`${sql.raw(name)} := ${value}`);
    }
  }
  return sql`ducklake_merge_adjacent_files(${sql.join(args, sql`, `)})`;
}

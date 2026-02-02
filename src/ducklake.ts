import type { DuckDBConnection } from '@duckdb/node-api';
import type { DuckDBConnectionPool } from './client.ts';
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
  metaParameterName?: string;
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
  return catalog.startsWith('ducklake:');
}

export function normalizeDuckLakeConfig(
  config: DuckLakeConfig
): NormalizedDuckLakeConfig {
  if (!config.catalog) {
    throw new Error('DuckLake config requires a catalog');
  }

  const catalog = isDuckLakeUri(config.catalog)
    ? config.catalog
    : `ducklake:${config.catalog}`;

  return {
    catalog,
    alias: config.alias?.trim() || DEFAULT_ALIAS,
    use: config.use ?? true,
    install: config.install ?? false,
    load: config.load ?? false,
    attachOptions: config.attachOptions,
  };
}

function optionValueToSql(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0';
  }
  return quoteString(value);
}

export function buildDuckLakeAttachSql(config: DuckLakeConfig): string {
  const normalized = normalizeDuckLakeConfig(config);
  const options: string[] = [];
  const attachOptions = normalized.attachOptions;

  if (attachOptions) {
    if (attachOptions.createIfNotExists !== undefined) {
      options.push(
        `CREATE_IF_NOT_EXISTS=${optionValueToSql(
          attachOptions.createIfNotExists
        )}`
      );
    }
    if (attachOptions.dataInliningRowLimit !== undefined) {
      options.push(
        `DATA_INLINING_ROW_LIMIT=${optionValueToSql(
          attachOptions.dataInliningRowLimit
        )}`
      );
    }
    if (attachOptions.dataPath) {
      options.push(`DATA_PATH=${optionValueToSql(attachOptions.dataPath)}`);
    }
    if (attachOptions.encrypted !== undefined) {
      options.push(`ENCRYPTED=${optionValueToSql(attachOptions.encrypted)}`);
    }
    if (attachOptions.metaParameterName) {
      options.push(
        `META_PARAMETER_NAME=${optionValueToSql(
          attachOptions.metaParameterName
        )}`
      );
    }
    if (attachOptions.metadataCatalog) {
      options.push(
        `METADATA_CATALOG=${optionValueToSql(attachOptions.metadataCatalog)}`
      );
    }
    if (attachOptions.overrideDataPath !== undefined) {
      options.push(
        `OVERRIDE_DATA_PATH=${optionValueToSql(attachOptions.overrideDataPath)}`
      );
    }
    if (attachOptions.readOnly !== undefined) {
      options.push(`READ_ONLY=${optionValueToSql(attachOptions.readOnly)}`);
    }
  }

  const attachSql = [
    `ATTACH ${quoteString(normalized.catalog)} AS ${quoteIdentifier(
      normalized.alias
    )}`,
  ];

  if (options.length > 0) {
    attachSql.push(`(${options.join(', ')})`);
  }

  return attachSql.join(' ');
}

export async function configureDuckLake(
  connection: DuckDBConnection,
  config: DuckLakeConfig
): Promise<void> {
  const normalized = normalizeDuckLakeConfig(config);

  if (normalized.install) {
    await connection.run('INSTALL ducklake');
  }

  if (normalized.load) {
    await connection.run('LOAD ducklake');
  }

  const attachSql = buildDuckLakeAttachSql(normalized);
  await connection.run(attachSql);

  if (normalized.use) {
    await connection.run(`USE ${quoteIdentifier(normalized.alias)}`);
  }
}

export function wrapDuckLakePool(
  pool: DuckDBConnectionPool,
  config: DuckLakeConfig
): DuckDBConnectionPool {
  const configuredConnections = new WeakSet<DuckDBConnection>();
  const poolWithSize = pool as unknown as { size?: number };
  const size =
    typeof poolWithSize.size === 'number' ? poolWithSize.size : undefined;

  const wrapped: DuckDBConnectionPool & { size?: number } = {
    async acquire() {
      const connection = await pool.acquire();
      if (!configuredConnections.has(connection)) {
        await configureDuckLake(connection, config);
        configuredConnections.add(connection);
      }
      return connection;
    },
    release(connection) {
      return pool.release(connection);
    },
    close: pool.close?.bind(pool),
  };

  if (size !== undefined) {
    wrapped.size = size;
  }

  return wrapped;
}

export function isDuckDbFileCatalog(catalog: string): boolean {
  const trimmed = catalog.trim();
  if (!trimmed) return false;

  if (trimmed === ':memory:') return true;
  if (isDuckLakeUri(trimmed)) {
    return isDuckDbFileCatalog(trimmed.slice('ducklake:'.length));
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('md:')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
  if (
    /^(postgres|postgresql|mysql|mariadb|sqlite|snowflake|bigquery):/i.test(
      trimmed
    )
  ) {
    return false;
  }

  return (
    trimmed.endsWith('.duckdb') ||
    trimmed.endsWith('.ddb') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~')
  );
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

import type {
  DuckDBConnection,
  DuckDBPreparedStatement,
  DuckDBValue,
} from '@duckdb/node-api';

type PreparedCacheEntry = {
  statement: DuckDBPreparedStatement;
};

const PREPARED_CACHE = Symbol.for('drizzle-duckdb:prepared-cache');

function destroyPreparedStatement(entry: PreparedCacheEntry | undefined): void {
  if (!entry) return;

  try {
    entry.statement.destroySync();
  } catch {
    // Ignore cleanup errors
  }
}

export class PreparedStatementCache {
  private entries = new Map<string, PreparedCacheEntry>();

  constructor(
    private connection: DuckDBConnection,
    private size: number
  ) {}

  resize(size: number): void {
    this.size = size;
  }

  async getOrPrepare(query: string): Promise<DuckDBPreparedStatement> {
    const cached = this.entries.get(query);
    if (cached) {
      return this.remember(query, cached.statement);
    }

    const statement = await this.connection.prepare(query);
    this.remember(query, statement);

    while (this.entries.size > this.size) {
      this.evictOldest();
    }

    return statement;
  }

  remember(
    query: string,
    statement: DuckDBPreparedStatement
  ): DuckDBPreparedStatement {
    this.entries.delete(query);
    this.entries.set(query, { statement });
    return statement;
  }

  evict(query: string): void {
    const entry = this.entries.get(query);
    this.entries.delete(query);
    destroyPreparedStatement(entry);
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      destroyPreparedStatement(entry);
    }
    this.entries.clear();
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next();
    if (!oldest.done) {
      this.evict(oldest.value);
    }
  }
}

export function getPreparedStatementCache(
  connection: DuckDBConnection,
  size: number
): PreparedStatementCache {
  const store = connection as unknown as Record<
    symbol,
    PreparedStatementCache | undefined
  >;
  const existing = store[PREPARED_CACHE];
  if (existing) {
    existing.resize(size);
    return existing;
  }

  const cache = new PreparedStatementCache(connection, size);
  store[PREPARED_CACHE] = cache;
  return cache;
}

export function clearPreparedStatementCache(
  connection: DuckDBConnection
): void {
  const store = connection as unknown as Record<
    symbol,
    PreparedStatementCache | undefined
  >;
  store[PREPARED_CACHE]?.clear();
}

export function bindPreparedStatement(
  statement: DuckDBPreparedStatement,
  values: DuckDBValue[] | undefined
): void {
  if (values) {
    statement.bind(values);
    return;
  }

  statement.clearBindings?.();
}

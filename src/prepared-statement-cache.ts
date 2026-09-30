import type {
  DuckDBConnection,
  DuckDBPreparedStatement,
  DuckDBType,
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
  private executionTail: Promise<void> = Promise.resolve();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  stats() {
    return {
      size: this.entries.size,
      capacity: this.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  constructor(
    private connection: DuckDBConnection,
    private size: number
  ) {}

  resize(size: number): void {
    this.size = size;
    this.trimToSize();
  }

  async getOrPrepare(query: string): Promise<DuckDBPreparedStatement> {
    const cached = this.entries.get(query);
    if (cached) {
      this.hits += 1;
      return this.remember(query, cached.statement);
    }

    this.misses += 1;
    const statement = await this.connection.prepare(query);
    this.remember(query, statement);

    return statement;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Binding mutates a native statement. Keep cached statement use serial on
    // each connection so concurrent callers cannot overwrite one another.
    const previous = this.executionTail;
    let release = () => {};
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  remember(
    query: string,
    statement: DuckDBPreparedStatement
  ): DuckDBPreparedStatement {
    this.entries.delete(query);
    this.entries.set(query, { statement });
    this.trimToSize();
    return statement;
  }

  evict(query: string): void {
    const entry = this.entries.get(query);
    if (entry) this.evictions += 1;
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

  private trimToSize(): void {
    while (this.entries.size > this.size) {
      this.evictOldest();
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

/** Read cache counters without creating or resizing the native cache. */
export function getPreparedStatementCacheStats(connection: DuckDBConnection) {
  const store = connection as unknown as Record<
    symbol,
    PreparedStatementCache | undefined
  >;
  return store[PREPARED_CACHE]?.stats();
}

export function bindPreparedStatement(
  statement: DuckDBPreparedStatement,
  values: DuckDBValue[] | undefined,
  types?: DuckDBType[]
): void {
  if (values) {
    if (types) {
      statement.bind(values, types);
    } else {
      statement.bind(values);
    }
    return;
  }

  statement.clearBindings?.();
}

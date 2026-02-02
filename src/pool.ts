import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { closeClientConnection, type DuckDBConnectionPool } from './client.ts';

/** Pool size presets for different MotherDuck instance types */
export type PoolPreset =
  | 'pulse'
  | 'standard'
  | 'jumbo'
  | 'mega'
  | 'giga'
  | 'local'
  | 'memory';

/** Pool sizes optimized for each MotherDuck instance type */
export const POOL_PRESETS: Record<PoolPreset, number> = {
  pulse: 4, // Auto-scaling, ad-hoc analytics
  standard: 6, // Balanced ETL/ELT workloads
  jumbo: 8, // Complex queries, high-volume
  mega: 12, // Large-scale transformations
  giga: 16, // Maximum parallelism
  local: 8, // Local DuckDB file
  memory: 4, // In-memory testing
};

export interface DuckDBPoolConfig {
  /** Maximum concurrent connections. Defaults to 4. */
  size?: number;
}

/**
 * Resolve pool configuration to a concrete size.
 * Returns false if pooling is disabled.
 */
export function resolvePoolSize(
  pool: DuckDBPoolConfig | PoolPreset | false | undefined
): number | false {
  if (pool === false) return false;
  if (pool === undefined) return 4;
  if (typeof pool === 'string') return POOL_PRESETS[pool];
  return pool.size ?? 4;
}

export interface DuckDBConnectionPoolOptions {
  /** Maximum concurrent connections. Defaults to 4. */
  size?: number;
  /** Timeout in milliseconds to wait for a connection. Defaults to 30000 (30s). */
  acquireTimeout?: number;
  /** Maximum number of requests waiting for a connection. Defaults to 100. */
  maxWaitingRequests?: number;
  /** Max time (ms) a connection may live before being recycled. */
  maxLifetimeMs?: number;
  /** Max idle time (ms) before an idle connection is discarded. */
  idleTimeoutMs?: number;
  /** Optional setup hook for newly created connections. */
  setup?: (connection: DuckDBConnection) => Promise<void>;
}

export function createDuckDBConnectionPool(
  instance: DuckDBInstance,
  options: DuckDBConnectionPoolOptions = {}
): DuckDBConnectionPool & { size: number } {
  const size = options.size && options.size > 0 ? options.size : 4;
  const acquireTimeout = options.acquireTimeout ?? 30_000;
  const maxWaitingRequests = options.maxWaitingRequests ?? 100;
  const maxLifetimeMs = options.maxLifetimeMs;
  const idleTimeoutMs = options.idleTimeoutMs;
  const setup = options.setup;
  const metadata = new WeakMap<
    DuckDBConnection,
    { createdAt: number; lastUsedAt: number }
  >();

  type PooledConnection = {
    connection: DuckDBConnection;
    createdAt: number;
    lastUsedAt: number;
  };

  const idle: PooledConnection[] = [];
  const waiting: Array<{
    resolve: (conn: DuckDBConnection) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];
  let total = 0;
  let closed = false;
  // Track pending acquires to handle race conditions during close
  let pendingAcquires = 0;

  const shouldRecycle = (conn: PooledConnection, now: number): boolean => {
    if (maxLifetimeMs !== undefined && now - conn.createdAt >= maxLifetimeMs) {
      return true;
    }
    if (idleTimeoutMs !== undefined && now - conn.lastUsedAt >= idleTimeoutMs) {
      return true;
    }
    return false;
  };

  const acquire = async (): Promise<DuckDBConnection> => {
    if (closed) {
      throw new Error('DuckDB connection pool is closed');
    }

    while (idle.length > 0) {
      const pooled = idle.pop() as PooledConnection;
      const now = Date.now();
      if (shouldRecycle(pooled, now)) {
        await closeClientConnection(pooled.connection);
        total = Math.max(0, total - 1);
        metadata.delete(pooled.connection);
        continue;
      }
      pooled.lastUsedAt = now;
      metadata.set(pooled.connection, {
        createdAt: pooled.createdAt,
        lastUsedAt: pooled.lastUsedAt,
      });
      return pooled.connection;
    }

    if (total < size) {
      pendingAcquires += 1;
      total += 1;
      try {
        const connection = await DuckDBConnection.create(instance);
        if (setup) {
          try {
            await setup(connection);
          } catch (error) {
            await closeClientConnection(connection);
            throw error;
          }
        }
        // Check if pool was closed during async connection creation
        if (closed) {
          await closeClientConnection(connection);
          total -= 1;
          throw new Error('DuckDB connection pool is closed');
        }
        const now = Date.now();
        metadata.set(connection, { createdAt: now, lastUsedAt: now });
        return connection;
      } catch (error) {
        total -= 1;
        throw error;
      } finally {
        pendingAcquires -= 1;
      }
    }

    // Check queue limit before waiting
    if (waiting.length >= maxWaitingRequests) {
      throw new Error(
        `DuckDB connection pool queue is full (max ${maxWaitingRequests} waiting requests)`
      );
    }

    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove this waiter from the queue
        const idx = waiting.findIndex((w) => w.timeoutId === timeoutId);
        if (idx !== -1) {
          waiting.splice(idx, 1);
        }
        reject(
          new Error(
            `DuckDB connection pool acquire timeout after ${acquireTimeout}ms`
          )
        );
      }, acquireTimeout);

      waiting.push({ resolve, reject, timeoutId });
    });
  };

  const release = async (connection: DuckDBConnection): Promise<void> => {
    const waiter = waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timeoutId);
      const now = Date.now();
      const meta =
        metadata.get(connection) ??
        ({ createdAt: now, lastUsedAt: now } as {
          createdAt: number;
          lastUsedAt: number;
        });

      const expired =
        maxLifetimeMs !== undefined && now - meta.createdAt >= maxLifetimeMs;

      if (closed) {
        await closeClientConnection(connection);
        total = Math.max(0, total - 1);
        metadata.delete(connection);
        waiter.reject(new Error('DuckDB connection pool is closed'));
        return;
      }

      if (expired) {
        await closeClientConnection(connection);
        total = Math.max(0, total - 1);
        metadata.delete(connection);
        try {
          const replacement = await acquire();
          waiter.resolve(replacement);
        } catch (error) {
          waiter.reject(error as Error);
        }
        return;
      }

      meta.lastUsedAt = now;
      metadata.set(connection, meta);
      waiter.resolve(connection);
      return;
    }

    if (closed) {
      await closeClientConnection(connection);
      metadata.delete(connection);
      total = Math.max(0, total - 1);
      return;
    }

    const now = Date.now();
    const existingMeta =
      metadata.get(connection) ??
      ({ createdAt: now, lastUsedAt: now } as {
        createdAt: number;
        lastUsedAt: number;
      });
    existingMeta.lastUsedAt = now;
    metadata.set(connection, existingMeta);

    if (
      maxLifetimeMs !== undefined &&
      now - existingMeta.createdAt >= maxLifetimeMs
    ) {
      await closeClientConnection(connection);
      total -= 1;
      metadata.delete(connection);
      return;
    }

    idle.push({
      connection,
      createdAt: existingMeta.createdAt,
      lastUsedAt: existingMeta.lastUsedAt,
    });
  };

  const close = async (): Promise<void> => {
    closed = true;

    // Clear all waiting requests with their timeouts
    const waiters = waiting.splice(0, waiting.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeoutId);
      waiter.reject(new Error('DuckDB connection pool is closed'));
    }

    // Close all idle connections (use allSettled to ensure all are attempted)
    const toClose = idle.splice(0, idle.length);
    await Promise.allSettled(
      toClose.map((item) => closeClientConnection(item.connection))
    );
    total = Math.max(0, total - toClose.length);
    toClose.forEach((item) => metadata.delete(item.connection));

    // Wait for pending acquires to complete (with a reasonable timeout)
    const maxWait = 5000;
    const start = Date.now();
    while (pendingAcquires > 0 && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  return {
    acquire,
    release,
    close,
    size,
  };
}

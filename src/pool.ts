import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { closeClientConnection, type DuckDBConnectionPool } from './client.ts';
import { normalizePositiveInteger } from './options.ts';

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

const DEFAULT_POOL_SIZE = 4;

export interface DuckDBPoolConfig {
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
}

/**
 * Resolve pool configuration to a concrete size.
 * Returns false if pooling is disabled.
 */
export function resolvePoolSize(
  pool: DuckDBPoolConfig | PoolPreset | false | undefined
): number | false {
  if (pool === false) return false;
  if (pool === undefined) return DEFAULT_POOL_SIZE;
  if (typeof pool === 'string') return POOL_PRESETS[pool] ?? DEFAULT_POOL_SIZE;
  return normalizePositiveInteger(pool.size, DEFAULT_POOL_SIZE);
}

export interface DuckDBConnectionPoolOptions extends DuckDBPoolConfig {
  /** Optional setup hook for newly created connections. */
  setup?: (connection: DuckDBConnection) => Promise<void>;
}

type ConnectionMetadata = {
  createdAt: number;
  lastUsedAt: number;
};

type PooledConnection = ConnectionMetadata & {
  connection: DuckDBConnection;
};

type WaitingRequest = {
  resolve: (conn: DuckDBConnection) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const POOL_CLOSED_MESSAGE = 'DuckDB connection pool is closed';

export function createDuckDBConnectionPool(
  instance: DuckDBInstance,
  options: DuckDBConnectionPoolOptions = {}
): DuckDBConnectionPool & { size: number } {
  const size = normalizePositiveInteger(options.size, DEFAULT_POOL_SIZE);
  const acquireTimeout = options.acquireTimeout ?? 30_000;
  const maxWaitingRequests = options.maxWaitingRequests ?? 100;
  const maxLifetimeMs = options.maxLifetimeMs;
  const idleTimeoutMs = options.idleTimeoutMs;
  const setup = options.setup;
  const metadata = new WeakMap<DuckDBConnection, ConnectionMetadata>();

  const idle: PooledConnection[] = [];
  const leased = new Set<DuckDBConnection>();
  const waiting: WaitingRequest[] = [];
  let total = 0;
  let closed = false;
  // Track pending acquires to handle race conditions during close
  let pendingAcquires = 0;

  const decrementTotal = (): void => {
    total = Math.max(0, total - 1);
  };

  const createMetadata = (now: number): ConnectionMetadata => ({
    createdAt: now,
    lastUsedAt: now,
  });

  const readMetadata = (
    connection: DuckDBConnection,
    now: number
  ): ConnectionMetadata => metadata.get(connection) ?? createMetadata(now);

  const markConnectionUsed = (
    connection: DuckDBConnection,
    meta: ConnectionMetadata,
    lastUsedAt: number
  ): ConnectionMetadata => {
    const nextMeta = {
      createdAt: meta.createdAt,
      lastUsedAt,
    };
    metadata.set(connection, nextMeta);
    return nextMeta;
  };

  const dropConnection = async (
    connection: DuckDBConnection
  ): Promise<void> => {
    await closeClientConnection(connection);
    decrementTotal();
    metadata.delete(connection);
  };

  const rejectWaiter = (waiter: WaitingRequest): void => {
    clearTimeout(waiter.timeoutId);
    waiter.reject(new Error(POOL_CLOSED_MESSAGE));
  };

  const hasExceededMaxLifetime = (
    meta: ConnectionMetadata,
    now: number
  ): boolean => {
    if (maxLifetimeMs !== undefined && now - meta.createdAt >= maxLifetimeMs) {
      return true;
    }
    return false;
  };

  const shouldRecycleIdleConnection = (
    meta: ConnectionMetadata,
    now: number
  ): boolean => {
    if (hasExceededMaxLifetime(meta, now)) {
      return true;
    }
    if (idleTimeoutMs !== undefined && now - meta.lastUsedAt >= idleTimeoutMs) {
      return true;
    }
    return false;
  };

  const toPooledConnection = (
    connection: DuckDBConnection,
    meta: ConnectionMetadata
  ): PooledConnection => ({
    connection,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
  });

  const acquire = async (): Promise<DuckDBConnection> => {
    if (closed) {
      throw new Error(POOL_CLOSED_MESSAGE);
    }

    while (idle.length > 0) {
      const pooled = idle.pop() as PooledConnection;
      const now = Date.now();
      if (shouldRecycleIdleConnection(pooled, now)) {
        await dropConnection(pooled.connection);
        continue;
      }
      markConnectionUsed(pooled.connection, pooled, now);
      leased.add(pooled.connection);
      return pooled.connection;
    }

    if (total < size) {
      pendingAcquires += 1;
      total += 1;
      let slotReleased = false;
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
          await dropConnection(connection);
          slotReleased = true;
          throw new Error(POOL_CLOSED_MESSAGE);
        }
        const now = Date.now();
        metadata.set(connection, createMetadata(now));
        leased.add(connection);
        return connection;
      } catch (error) {
        if (!slotReleased) {
          decrementTotal();
        }
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
    if (!leased.delete(connection)) {
      return;
    }

    const waiter = waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timeoutId);
      const now = Date.now();
      const meta = readMetadata(connection, now);

      if (closed) {
        await dropConnection(connection);
        waiter.reject(new Error(POOL_CLOSED_MESSAGE));
        return;
      }

      if (hasExceededMaxLifetime(meta, now)) {
        await dropConnection(connection);
        try {
          const replacement = await acquire();
          waiter.resolve(replacement);
        } catch (error) {
          waiter.reject(error as Error);
        }
        return;
      }

      markConnectionUsed(connection, meta, now);
      leased.add(connection);
      waiter.resolve(connection);
      return;
    }

    if (closed) {
      await dropConnection(connection);
      return;
    }

    const now = Date.now();
    const existingMeta = markConnectionUsed(
      connection,
      readMetadata(connection, now),
      now
    );

    if (hasExceededMaxLifetime(existingMeta, now)) {
      await dropConnection(connection);
      return;
    }

    idle.push(toPooledConnection(connection, existingMeta));
  };

  const close = async (): Promise<void> => {
    closed = true;

    // Clear all waiting requests with their timeouts
    const waiters = waiting.splice(0, waiting.length);
    for (const waiter of waiters) {
      rejectWaiter(waiter);
    }

    // Close all idle connections (use allSettled to ensure all are attempted)
    const toClose = idle.splice(0, idle.length);
    await Promise.allSettled(
      toClose.map((item) => closeClientConnection(item.connection))
    );
    total = Math.max(0, total - toClose.length);
    toClose.forEach((item) => metadata.delete(item.connection));

    const active = Array.from(leased);
    leased.clear();
    await Promise.allSettled(
      active.map((connection) => closeClientConnection(connection))
    );
    total = Math.max(0, total - active.length);
    active.forEach((connection) => metadata.delete(connection));

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

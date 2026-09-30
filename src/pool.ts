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
  /** Queue wait timeout in ms, excluding connection creation/setup. Defaults to 30000. */
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
  queuedAt: number | undefined;
  resolve: (conn: DuckDBConnection) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
};

const POOL_CLOSED_MESSAGE = 'DuckDB connection pool is closed';

/** The largest delay setTimeout accepts. Larger values fire after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Resolve acquireTimeout. `0` and `Infinity` wait without a timeout, and
 * values above the setTimeout limit are clamped to it.
 */
function resolveAcquireTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return 30_000;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new Error(
      `acquireTimeout must be a non-negative number of milliseconds, 0 or Infinity for no timeout. Received ${String(value)}`
    );
  }
  if (value === 0 || value === Infinity) return undefined;
  return Math.min(value, MAX_TIMEOUT_MS);
}

function resolveMaxWaitingRequests(value: number | undefined): number {
  if (value === undefined) return 100;
  if (
    typeof value !== 'number' ||
    value < 0 ||
    (!Number.isInteger(value) && value !== Infinity)
  ) {
    throw new Error(
      `maxWaitingRequests must be a non-negative integer or Infinity. Received ${String(value)}`
    );
  }
  return value;
}

export function createDuckDBConnectionPool(
  instance: DuckDBInstance,
  options: DuckDBConnectionPoolOptions = {}
): DuckDBConnectionPool & {
  size: number;
  close(): Promise<void>;
  stats(): DuckDBPoolStats;
} {
  const size = normalizePositiveInteger(options.size, DEFAULT_POOL_SIZE);
  const acquireTimeout = resolveAcquireTimeout(options.acquireTimeout);
  const maxWaitingRequests = resolveMaxWaitingRequests(
    options.maxWaitingRequests
  );
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
  let created = 0;
  let recycled = 0;
  let queued = 0;
  let queueWaitMs = 0;
  let timedOut = 0;

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
    try {
      await closeClientConnection(connection);
    } finally {
      decrementTotal();
      metadata.delete(connection);
    }
  };

  const finishQueueWait = (waiter: WaitingRequest): void => {
    if (waiter.queuedAt !== undefined) {
      queueWaitMs += Date.now() - waiter.queuedAt;
      waiter.queuedAt = undefined;
    }
  };

  const resolveWaiter = (
    waiter: WaitingRequest,
    connection: DuckDBConnection
  ): void => {
    clearTimeout(waiter.timeoutId);
    finishQueueWait(waiter);
    waiter.resolve(connection);
  };

  const rejectWaiter = (waiter: WaitingRequest, error: Error): void => {
    clearTimeout(waiter.timeoutId);
    finishQueueWait(waiter);
    waiter.reject(error);
  };

  const takeWaiter = (): WaitingRequest | undefined => {
    const waiter = waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timeoutId);
      finishQueueWait(waiter);
    }
    return waiter;
  };

  const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

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

  // The caller owns dequeueing and cancelling the timer. A replacement
  // failure belongs to this waiter's acquire, not to the releasing caller.
  const acquireForWaiter = (waiter: WaitingRequest): Promise<void> =>
    acquire().then(
      (connection) => resolveWaiter(waiter, connection),
      (error) => rejectWaiter(waiter, toError(error))
    );

  const retryNextWaiter = (): void => {
    if (closed) return;

    const waiter = takeWaiter();
    if (!waiter) return;

    void acquireForWaiter(waiter);
  };

  const acquire = async (): Promise<DuckDBConnection> => {
    if (closed) {
      throw new Error(POOL_CLOSED_MESSAGE);
    }

    while (idle.length > 0) {
      const pooled = idle.pop() as PooledConnection;
      const now = Date.now();
      if (shouldRecycleIdleConnection(pooled, now)) {
        recycled += 1;
        try {
          await dropConnection(pooled.connection);
        } catch (error) {
          retryNextWaiter();
          throw error;
        }
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
        created += 1;
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
          retryNextWaiter();
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
      const waiter: WaitingRequest = {
        resolve,
        reject,
        timeoutId: undefined,
        queuedAt: Date.now(),
      };
      queued += 1;
      if (acquireTimeout !== undefined) {
        waiter.timeoutId = setTimeout(() => {
          // Remove this waiter from the queue
          const idx = waiting.indexOf(waiter);
          if (idx !== -1) {
            waiting.splice(idx, 1);
          }
          timedOut += 1;
          finishQueueWait(waiter);
          reject(
            new Error(
              `DuckDB connection pool acquire timeout after ${acquireTimeout}ms`
            )
          );
        }, acquireTimeout);
      }

      waiting.push(waiter);
    });
  };

  const release = async (connection: DuckDBConnection): Promise<void> => {
    if (!leased.delete(connection)) {
      return;
    }

    const now = Date.now();
    const meta = readMetadata(connection, now);

    if (closed) {
      await dropConnection(connection);
      return;
    }

    if (hasExceededMaxLifetime(meta, now)) {
      recycled += 1;
      try {
        await dropConnection(connection);
      } catch (error) {
        retryNextWaiter();
        throw error;
      }

      const waiter = takeWaiter();
      if (waiter) {
        await acquireForWaiter(waiter);
      }
      return;
    }

    const waiter = takeWaiter();
    if (waiter) {
      markConnectionUsed(connection, meta, now);
      leased.add(connection);
      resolveWaiter(waiter, connection);
      return;
    }

    const existingMeta = markConnectionUsed(connection, meta, now);
    idle.push(toPooledConnection(connection, existingMeta));
  };

  const close = async (): Promise<void> => {
    closed = true;

    // Clear all waiting requests with their timeouts
    const waiters = waiting.splice(0, waiting.length);
    for (const waiter of waiters) {
      rejectWaiter(waiter, new Error(POOL_CLOSED_MESSAGE));
    }

    // Close all idle connections (use allSettled to ensure all are attempted)
    const toClose = idle.splice(0, idle.length);
    await Promise.allSettled(
      toClose.map((item) => closeClientConnection(item.connection))
    );
    total = Math.max(0, total - toClose.length);
    toClose.forEach((item) => metadata.delete(item.connection));

    // closeClientConnection interrupts a query still running on a leased
    // connection and waits (bounded) for it to settle before disconnecting,
    // so the caller's promise rejects instead of staying pending. A later
    // release() of these connections is a no-op.
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
    stats: () => ({
      size,
      total,
      idle: idle.length,
      leased: leased.size,
      waiting: waiting.length,
      pending: pendingAcquires,
      created,
      recycled,
      queued,
      queueWaitMs,
      timedOut,
      closed,
    }),
  };
}

export interface DuckDBPoolStats {
  size: number;
  total: number;
  idle: number;
  leased: number;
  waiting: number;
  pending: number;
  created: number;
  recycled: number;
  queued: number;
  queueWaitMs: number;
  timedOut: number;
  closed: boolean;
}

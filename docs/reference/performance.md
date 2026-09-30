---
layout: default
title: Performance Tuning
parent: Reference
nav_order: 5
---

# Performance Tuning

Settings and query patterns that affect DuckDB throughput and latency.

## Quick Wins

These settings help most workloads:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';
import { createDuckDBConnectionPool } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create(':memory:');

// Option 1: Single connection with prepared statement cache
const connection = await instance.connect();
const dbSingle = drizzle(connection, {
  prepareCache: { size: 64 },
});

// Option 2: Connection pool for concurrent workloads
const pool = createDuckDBConnectionPool(instance, { size: 8 });
const dbPooled = drizzle({ client: pool, prepareCache: { size: 64 } });
```

## Prepared Statement Caching

Reusing a prepared statement skips parsing and planning for repeated SQL. In the benchmark below, reuse ran about 20% faster than a fresh query. Enable caching to reuse prepared statements across identical queries.

### Configuration

```typescript
// Enable with default size (32 statements)
const db = drizzle(connection, { prepareCache: true });

// Custom cache size
const db = drizzle(connection, { prepareCache: { size: 100 } });

// Disable (default)
const db = drizzle(connection);
```

### How It Works

1. First execution of a query prepares the statement and caches it
2. Subsequent executions with the same SQL reuse the cached statement
3. LRU eviction removes least-recently-used statements when cache is full

Bindings are mutable on native prepared statements, so cached executions are
serialized per connection to keep concurrent parameter sets isolated. Use a
connection pool for parallel query execution. Each pooled connection keeps its
own cache.

SQL with several statements, or with only comments, cannot be prepared. It runs
without the cache.

### Sizing Guidelines

| Workload Type               | Recommended Size |
| --------------------------- | ---------------- |
| Simple CRUD app             | 32 (default)     |
| Dashboard with many queries | 64-100           |
| Analytics with complex CTEs | 100-200          |
| High-volume API server      | 200+             |

### Benchmark Results

```
prepared select reuse:    4,349 ops/sec
fresh query each time:    3,580 ops/sec  (22% slower)
```

## Connection Pooling

Use connection pooling for applications with concurrent database access.

### Basic Pool Setup

```typescript
import { createDuckDBConnectionPool } from '@duckdbfan/drizzle-duckdb';

const pool = createDuckDBConnectionPool(instance, {
  size: 8, // Number of connections
  acquireTimeout: 30000, // Max wait time (ms)
  maxWaitingRequests: 100, // Max queued requests
});

const db = drizzle({ client: pool, prepareCache: { size: 64 } });
```

### Pool Presets for MotherDuck

```typescript
// Optimized presets for MotherDuck instance types
const db = await drizzle('md:', { pool: 'standard' });
```

| Preset     | Pool Size | Use Case             |
| ---------- | --------- | -------------------- |
| `memory`   | 4         | In-memory databases  |
| `local`    | 8         | Local file databases |
| `pulse`    | 4         | MotherDuck Pulse     |
| `standard` | 6         | MotherDuck Standard  |
| `jumbo`    | 8         | MotherDuck Jumbo     |
| `mega`     | 12        | MotherDuck Mega      |
| `giga`     | 16        | MotherDuck Giga      |

### Connection Lifecycle

```typescript
const pool = createDuckDBConnectionPool(instance, {
  size: 8,
  maxLifetimeMs: 3600000, // Recycle connections after 1 hour
  idleTimeoutMs: 300000, // Close idle connections after 5 minutes
});
```

### Benchmark: Pool vs Single Connection

```
10 concurrent queries:
  Single connection: 2,120ms (serialized)
  Pool (size 4):       657ms (3.2x faster)

Heavy workload (8 concurrent):
  Single: 953ms
  Pool:   244ms (3.9x faster)
```

## Streaming Large Results

For queries returning many rows, use streaming to avoid memory pressure.

### Batch Streaming

```typescript
import { sql } from 'drizzle-orm';

// Stream 100,000 rows per batch
for await (const rows of db.executeBatches(sql`SELECT * FROM large_table`, {
  rowsPerChunk: 100000,
})) {
  // Process each chunk of mapped rows
  for (const row of rows) {
    processRow(row);
  }
}
```

### Raw Array Streaming

For maximum performance with large datasets:

```typescript
// Stream raw arrays (no object mapping overhead)
for await (const chunk of db.executeBatchesRaw(
  sql`SELECT id, name FROM users`
)) {
  // chunk.columns: string[]
  // chunk.rows: unknown[][]
  for (const row of chunk.rows) {
    const id = row[0];
    const name = row[1];
  }
}
```

### Columnar Results

`executeArrow()` returns column-major data:

```typescript
const columns = await db.executeArrow(sql`SELECT id, name FROM users`);
// { id: [1, 2, ...], name: ['Alice', 'Bob', ...] }
```

It returns an Arrow table only when the client result exposes an Arrow API. `@duckdb/node-api` does not, so with it you get plain JavaScript arrays keyed by column name. The whole result is materialized.

### Measure materialization and streaming

Run `bun run perf:run` to compare native rows, raw objects, builders, columnar output, streaming, native caching, concurrency and exact decimal conversion. Benchmarks validate row counts or checksums. The output includes throughput and relative margin of error, with runtime, CPU, dependency and dataset metadata in `action-bench.json.meta.json`. Raw Vitest measurements are saved under `perf-results/`.

Use `bun run perf:compare -- --fail-on-regression old.json new.json` to reject missing measurements or a throughput drop beyond the threshold and reported uncertainty. `--allow-new` permits added benchmarks, while removed benchmarks still fail. Pull requests measure their base revision on the same runner before applying this gate. Historical action reports use a `105.2631579%` worsening ratio for a 5% throughput drop and report alerts without independently failing the job.

After building, run `node --expose-gc scripts/measure-memory.ts` with Node 24 or newer for separate-process memory comparisons. It saves RSS observations and checksums in `perf-results/memory.json`. RSS is sampled, so observed peaks are lower bounds. Latency alone does not establish memory efficiency.

Pools expose `pool.stats()` for current leases, idle connections, pending creation, queue depth, queue wait time, timeouts and recycling. `getPreparedStatementCacheStats(connection)` reports native cache hits, misses, evictions and capacity without creating a cache. Measure these counters before changing pool or cache sizes.

## Query Optimization

### Use Specific Column Selection

```typescript
// Slower: fetches all columns
const users = await db.select().from(usersTable);

// Faster: fetch only needed columns
const users = await db
  .select({ id: usersTable.id, name: usersTable.name })
  .from(usersTable);
```

### Benchmark: Wide vs Narrow Selection

```
Wide row (8 columns):   39 ops/sec
Narrow (2 columns):  4,707 ops/sec
```

### Prefer Native DuckDB Types

Use DuckDB-native column helpers instead of Postgres equivalents. `duckDbList`, `duckDbJson` and the other helpers are column builders. They wrap values at bind time, so pass plain arrays and objects:

```typescript
import { duckDbList, duckDbJson } from '@duckdbfan/drizzle-duckdb';

const table = pgTable('items', {
  tags: duckDbList<string>('tags', 'VARCHAR'),
  metadata: duckDbJson<{ key: string }>('metadata'),
});

await db.insert(table).values({
  tags: ['a', 'b', 'c'],
  metadata: { key: 'value' },
});
```

### Use Indexes

DuckDB supports indexes for point lookups:

```typescript
await db.execute(sql`
  CREATE INDEX users_email_idx ON users(email)
`);
```

### Leverage DuckDB's Columnar Engine

DuckDB is built for analytical queries. Structure queries to benefit from columnar processing:

```typescript
// Good: Aggregation on large dataset (DuckDB strength)
const stats = await db
  .select({
    category: products.category,
    total: sql<number>`sum(${products.price})`,
    count: sql<number>`count(*)`.mapWith(Number), // COUNT reads as a bigint otherwise
  })
  .from(products)
  .groupBy(products.category);

// Also efficient: Filtered scans with predicates
const filtered = await db
  .select()
  .from(events)
  .where(and(gte(events.timestamp, startDate), eq(events.type, 'purchase')));
```

## Migrating from PostgreSQL

When migrating from PostgreSQL, consider these performance differences:

### Array Operators

PostgreSQL array operators (`@>`, `<@`, `&&`) run natively in DuckDB and are not rewritten, so they add no parsing overhead. The DuckDB-named helpers produce the equivalent `array_has_*` calls:

```typescript
import { arrayHasAll, arrayHasAny } from '@duckdbfan/drizzle-duckdb';

// Postgres operator, sent as written
const result = await db
  .select()
  .from(posts)
  .where(sql`${posts.tags} @> ['featured']`);

// DuckDB function names
const result = await db
  .select()
  .from(posts)
  .where(arrayHasAll(posts.tags, ['featured']));

// Overlap check with native helper
const overlapping = await db
  .select()
  .from(posts)
  .where(arrayHasAny(posts.tags, ['featured', 'trending']));
```

### JSON Columns

Use `duckDbJson()` instead of Postgres `json`/`jsonb`:

```typescript
import { duckDbJson } from '@duckdbfan/drizzle-duckdb';

const table = pgTable('events', {
  id: integer('id').primaryKey(),
  // Use this:
  metadata: duckDbJson('metadata'),
  // Not this (throws error):
  // metadata: json('metadata'),
});
```

### CTEs and JOINs

CTEs work as in Postgres. CTE and subquery fields render qualified by their alias, so JOIN conditions on shared column names do not hit ambiguity errors:

```typescript
const cte = db.$with('stats').as(
  db
    .select({
      userId: orders.userId,
      total: sql<number>`sum(${orders.amount})`.as('total'),
    })
    .from(orders)
    .groupBy(orders.userId)
);

// ... on "users"."id" = "stats"."userId"
const result = await db
  .with(cte)
  .select()
  .from(users)
  .leftJoin(cte, eq(users.id, cte.userId));
```

## Monitoring Performance

### Query Timing

Track representative query latency in your runtime environment:

```typescript
const startedAt = Date.now();
await db.select().from(users).limit(1000);
const elapsedMs = Date.now() - startedAt;
console.log(`Query took ${elapsedMs}ms`);
```

### Warm-Up Critical Queries

For latency-sensitive applications, warm up caches at startup:

```typescript
async function warmUp(db) {
  // Execute critical queries once to populate caches
  await db.select().from(users).limit(1);
  await db.select().from(orders).limit(1);
  // ... other frequently-used queries
}

// Call during application startup
await warmUp(db);
```

## Performance Checklist

- [ ] Enable prepared statement caching (`prepareCache: { size: 64 }`)
- [ ] Use connection pooling for concurrent access
- [ ] Stream large result sets with `db.executeBatches()`
- [ ] Select only needed columns
- [ ] Use native DuckDB type helpers (`duckDbList`, `duckDbJson`, etc.)
- [ ] Create indexes for frequently-queried columns
- [ ] Use `duckDbJson()` instead of Postgres `json`/`jsonb`
- [ ] Warm up caches at application startup
- [ ] Track query latency and pool queue behavior in production

## Troubleshooting Slow Queries

### Symptoms and Solutions

| Symptom                                | Likely Cause                | Solution              |
| -------------------------------------- | --------------------------- | --------------------- |
| First query is slow, repeats are fast  | Cache population            | Warm up at startup    |
| All queries uniformly slow             | No prepared statement cache | Enable `prepareCache` |
| Concurrent requests queue up           | Single connection           | Use connection pool   |
| Memory spikes on large results         | Full materialization        | Use streaming         |
| JOIN queries fail with ambiguous error | Unqualified raw SQL columns | Qualify the columns   |

### Enable Query Logging

```typescript
// Log all executed queries
const db = drizzle(connection, {
  logger: true,
});

// Custom logger
const db = drizzle(connection, {
  logger: {
    logQuery(query, params) {
      console.log('Query:', query);
      console.log('Params:', params);
    },
  },
});
```

## Next Steps

- [Configuration]({{ '/reference/configuration' | relative_url }}): configuration options
- [MotherDuck Integration]({{ '/integrations/motherduck' | relative_url }}): cloud database setup
- [Limitations]({{ '/reference/limitations' | relative_url }}): known differences from Postgres

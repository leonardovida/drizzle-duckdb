---
layout: default
title: Performance Tuning
parent: Reference
nav_order: 5
---

# Performance Tuning

Optimize your DuckDB application for maximum throughput and minimum latency.

## Quick Wins

These settings provide immediate performance improvements for most workloads:

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

Prepared statements are **5-10x faster** than ad-hoc queries. Enable caching to reuse prepared statements across identical queries.

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

### Arrow Format

For interop with analytical tools:

```typescript
const arrow = await db.executeArrow(sql`SELECT * FROM large_table`);
// Returns Arrow table for zero-copy analytics
```

### Benchmark: Materialized vs Streaming

```
100K row scan:
  Full materialization:  817ms
  Batch streaming:        67ms (12x faster memory efficiency)
```

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

Use DuckDB-native type helpers instead of Postgres equivalents:

```typescript
import {
  duckDbList,
  duckDbArray,
  duckDbJson,
  duckDbStruct,
} from '@duckdbfan/drizzle-duckdb';

// Faster: pre-wrapped DuckDB value
await db.insert(table).values({
  tags: duckDbList(['a', 'b', 'c']),
  metadata: duckDbJson({ key: 'value' }),
});

// Slower: requires runtime conversion
await db.insert(table).values({
  tags: ['a', 'b', 'c'], // Converted at runtime
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

DuckDB excels at analytical queries. Structure queries to benefit from columnar processing:

```typescript
// Good: Aggregation on large dataset (DuckDB strength)
const stats = await db
  .select({
    category: products.category,
    total: sql<number>`sum(${products.price})`,
    count: sql<number>`count(*)`,
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

PostgreSQL array operators (`@>`, `<@`, `&&`) are automatically rewritten to DuckDB functions. For best performance, use DuckDB-native array functions directly:

```typescript
import { arrayHasAll, arrayHasAny } from '@duckdbfan/drizzle-duckdb';

// Automatic rewrite (works but has parsing overhead on first execution)
const result = await db
  .select()
  .from(posts)
  .where(sql`${posts.tags} @> ARRAY['featured']`);

// Native DuckDB (no rewrite overhead)
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

CTEs work seamlessly. Column references in JOIN conditions are automatically qualified to prevent ambiguity errors:

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

// Columns are automatically qualified in the ON clause
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
- [ ] Stream large result sets with `executeInBatches()`
- [ ] Select only needed columns
- [ ] Use native DuckDB type helpers (`duckDbList`, `duckDbJson`, etc.)
- [ ] Create indexes for frequently-queried columns
- [ ] Use `duckDbJson()` instead of Postgres `json`/`jsonb`
- [ ] Warm up caches at application startup
- [ ] Track query latency and pool queue behavior in production

## Troubleshooting Slow Queries

### Symptoms and Solutions

| Symptom                                | Likely Cause                | Solution                 |
| -------------------------------------- | --------------------------- | ------------------------ |
| First query is slow, repeats are fast  | Cache population            | Warm up at startup       |
| All queries uniformly slow             | No prepared statement cache | Enable `prepareCache`    |
| Concurrent requests queue up           | Single connection           | Use connection pool      |
| Memory spikes on large results         | Full materialization        | Use streaming            |
| JOIN queries fail with ambiguous error | Unqualified columns         | Update to latest version |

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

- [Configuration]({{ '/reference/configuration' | relative_url }}) - All configuration options
- [MotherDuck Integration]({{ '/integrations/motherduck' | relative_url }}) - Cloud database setup
- [Limitations]({{ '/reference/limitations' | relative_url }}) - Known differences from Postgres

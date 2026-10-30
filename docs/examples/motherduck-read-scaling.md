---
layout: default
title: MotherDuck Read Scaling
parent: Examples
nav_order: 6
---

# MotherDuck Read Scaling Example

A customer-facing analytics backend that serves dashboards to many users at once. One writer loads data with a read/write token. Readers connect with a [read scaling token](https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/read-scaling/), which spreads them over a pool of read-only replica Ducklings.

**Source**: [example/motherduck-read-scaling.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/motherduck-read-scaling.ts)

## Prerequisites

- `MOTHERDUCK_TOKEN`: a read/write token for setup and writes
- `MOTHERDUCK_READ_SCALING_TOKEN` (optional): a read scaling token for readers. Without it, readers use the read/write token and every query runs on the read/write Duckling.
- `MOTHERDUCK_EXAMPLE_DB` (optional): the database to use, `drizzle_examples` by default. The script replaces only the `readers_orders` table.

## Run the Example

```bash
export MOTHERDUCK_TOKEN=your_read_write_token
export MOTHERDUCK_READ_SCALING_TOKEN=your_read_scaling_token
bun example/motherduck-read-scaling.ts
```

## What It Demonstrates

- Seeding 2 million rows with one `CREATE TABLE AS` statement run on the Duckling
- A reader router with one DuckDB instance per replica slot, each with a fixed `session_name`. Hashing the user ID picks the slot, so each user keeps a warm replica while users spread across replicas.
- `DuckDBInstance.fromCache()`, `attach_mode=single` and `motherduck_dbinstance_inactivity_ttl` on reader instances
- Bounded connection pools per replica with `acquireTimeout` and `maxWaitingRequests`, and per-replica latency and queue statistics from `pool.stats()`
- Dashboard pages that run three typed queries in parallel
- Read after write with `CREATE SNAPSHOT OF` on the writer and `REFRESH DATABASE` on the reader

## Key Snippet

```typescript
const instance = await DuckDBInstance.fromCache(
  `md:${database}?attach_mode=single&session_name=dashboard-replica-${slot}`,
  {
    motherduck_token: process.env.MOTHERDUCK_READ_SCALING_TOKEN,
    motherduck_dbinstance_inactivity_ttl: '5m',
  }
);
const pool = createDuckDBConnectionPool(instance, {
  size: 3,
  acquireTimeout: 30_000,
  maxWaitingRequests: 100,
});
const db = drizzle({ client: pool });
```

## Notes

- Read scaling tokens allow `SELECT` only. They cannot write, create databases or attach them, so the writer creates the database first.
- Replicas are eventually consistent and catch up on their own within minutes. `CREATE SNAPSHOT OF <db>` followed by `REFRESH DATABASE <db>` on a reader makes new writes visible right away. The read/write Duckling rejects `REFRESH DATABASE`, which is why the example refreshes only when a read scaling token is set.
- The read scaling pool has 4 replicas by default and can be raised to 16. Plan one replica slot in the router per replica.

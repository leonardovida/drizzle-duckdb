---
layout: default
title: FAQ
parent: Reference
nav_order: 3
---

# FAQ

Frequently asked questions about Drizzle DuckDB.

## General

### Why use `pgTable` for DuckDB schema definitions?

DuckDB's SQL is largely Postgres-compatible. Using `pgTable` from `drizzle-orm/pg-core` means you get:

- Full TypeScript type inference
- Complete query builder support
- Familiar API for Drizzle users

The DuckDB adapter translates Postgres-style queries to work with DuckDB where needed.

### Can I use Drizzle Kit with DuckDB?

Yes, with some caveats:

1. Use `dialect: 'postgresql'` in your `drizzle.config.ts`
2. Generated SQL may need manual adjustment for DuckDB compatibility
3. Some Postgres features won't work

```typescript
// drizzle.config.ts
export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
};
```

### Does it work with MotherDuck?

Yes! Connect using the `md:` URL prefix:

```typescript
const instance = await DuckDBInstance.create('md:', {
  motherduck_token: process.env.MOTHERDUCK_TOKEN,
});
```

See the [MotherDuck guide]({{ '/integrations/motherduck' | relative_url }}) for details.

### What about DuckDB WASM (browser)?

Currently, this package only supports `@duckdb/node-api` (Node.js). Browser support via DuckDB WASM is not available.

For browser use, consider:

- Using an API endpoint that queries DuckDB server-side
- Using MotherDuck with a server-side proxy
- Trying the community `@proj-airi/drizzle-duckdb-wasm` driver for DuckDB WASM. It is not officially supported by this package.

## Compatibility

### What Postgres features don't work?

| Feature                    | Status                        | Alternative                                             |
| -------------------------- | ----------------------------- | ------------------------------------------------------- |
| `json()` / `jsonb()`       | Not supported                 | Use `duckDbJson()`                                      |
| `SAVEPOINT`                | Not supported                 | Avoid nested transactions                               |
| Prepared statement caching | Available with `prepareCache` | Cache is per connection                                 |
| Result streaming           | Chunked reads                 | Use `executeBatches()` / `executeArrow()` or pagination |
| Concurrent queries         | One/query/conn                | Use connection pooling for parallelism                  |
| `SERIAL` type              | Not available                 | Use sequences with `nextval()`                          |

See [Limitations]({{ '/reference/limitations' | relative_url }}) for the complete list.

### Can I migrate from Postgres to DuckDB?

For most schemas, yes. Key changes needed:

1. Replace `json`/`jsonb` with `duckDbJson`
2. Handle timestamp differences (DuckDB uses space separator, not `T`)
3. Replace `SERIAL` with sequence + `nextval()`
4. Adjust array operator usage

### Is DuckDB faster than Postgres?

It depends on the workload:

| Use Case                                 | DuckDB | Postgres |
| ---------------------------------------- | ------ | -------- |
| Analytical queries (aggregations, scans) | Faster | Slower   |
| Complex joins on large datasets          | Faster | Slower   |
| High-frequency single-row inserts        | Slower | Faster   |
| OLTP workloads                           | Slower | Faster   |

DuckDB is optimized for OLAP (analytical) workloads, not OLTP (transactional).

## Types

### How do I use DuckDB's STRUCT type?

```typescript
import { duckDbStruct } from '@leonardovida-md/drizzle-neo-duckdb';

const users = pgTable('users', {
  address: duckDbStruct<{
    street: string;
    city: string;
    zip: string;
  }>('address', {
    street: 'TEXT',
    city: 'TEXT',
    zip: 'VARCHAR',
  }),
});
```

### What's the difference between LIST and ARRAY?

- **LIST**: Variable length, any number of elements
- **ARRAY**: Fixed length, must specify size

```typescript
// Variable length list
tags: duckDbList<string>('tags', 'TEXT'),

// Fixed length array (exactly 3 elements)
rgb: duckDbArray<number>('rgb', 'INTEGER', 3),
```

### How do I query JSON fields?

Use DuckDB's JSON operators in raw SQL:

```typescript
const result = await db.execute(sql`
  SELECT
    metadata->>'name' as name,
    metadata->'settings'->>'theme' as theme
  FROM users
  WHERE metadata->>'role' = 'admin'
`);
```

## Performance

### How do I batch inserts?

Use arrays with `.values()`:

```typescript
// Good: single batch insert
await db
  .insert(users)
  .values([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }]);

// Bad: multiple round trips
for (const name of ['Alice', 'Bob', 'Carol']) {
  await db.insert(users).values({ name });
}
```

### How do I handle large result sets?

Use pagination to avoid loading everything into memory:

```typescript
const pageSize = 1000;
let offset = 0;

while (true) {
  const batch = await db.select().from(users).limit(pageSize).offset(offset);

  if (batch.length === 0) break;

  // Process batch
  await processBatch(batch);

  offset += pageSize;
}
```

### How do I tune connection pooling?

- Connection strings auto-create a pool (default size: 4). Set size or MotherDuck presets with `pool: { size: 8 }` or `pool: 'jumbo'`.
- Disable pooling with `pool: false` if you truly want a single connection.
- For timeouts/queue limits/recycling, build the pool manually:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { createDuckDBConnectionPool } from '@leonardovida-md/drizzle-neo-duckdb';

const instance = await DuckDBInstance.create(':memory:');
const pool = createDuckDBConnectionPool(instance, {
  size: 8,
  acquireTimeout: 20_000,
  maxWaitingRequests: 200,
  maxLifetimeMs: 10 * 60_000,
  idleTimeoutMs: 60_000,
});
```

Transactions automatically pin one pooled connection; other queries keep using the pool.

### Can I use indexes?

Yes, DuckDB supports indexes:

```typescript
await db.execute(sql`
  CREATE INDEX idx_users_email ON users(email)
`);
```

However, DuckDB often performs well without indexes due to its columnar storage and vectorized execution.

## Framework Integration

### Does it work with Next.js?

Yes. Add to `next.config.js`:

```javascript
const nextConfig = {
  serverExternalPackages: ['@duckdb/node-api'],
};
```

See the [Next.js guide]({{ '/integrations/nextjs' | relative_url }}) for full setup.

### Does it work with Bun?

Yes! Bun is the recommended runtime:

```bash
bun add @leonardovida-md/drizzle-neo-duckdb @duckdb/node-api
```

See the [Bun guide]({{ '/integrations/bun' | relative_url }}) for details.

### Can I use it in serverless functions?

Yes, but be mindful of:

- Cold start times (DuckDB initialization)
- Connection cleanup
- Memory limits

For serverless, consider:

- Using MotherDuck for persistent storage
- Implementing connection pooling patterns
- Using `:memory:` databases for stateless operations

## Troubleshooting

### Why do I get "JSON/JSONB not supported"?

DuckDB has its own JSON type. Replace:

```typescript
// Before
import { json } from 'drizzle-orm/pg-core';

// After
import { duckDbJson } from '@leonardovida-md/drizzle-neo-duckdb';
```

### Why doesn't my transaction rollback work as expected?

DuckDB doesn't support `SAVEPOINT`. Nested transactions share the outer transaction, and a rollback in any nested transaction aborts everything.

See [Transactions]({{ '/core/transactions' | relative_url }}) for patterns.

### Why is introspection returning tables from other databases?

When connected to MotherDuck, you may have multiple databases attached. Use the `database` option:

```typescript
const result = await introspect(db, {
  database: 'my_database', // Only introspect this database
});
```

## See Also

- [Troubleshooting]({{ '/reference/troubleshooting' | relative_url }}) - Detailed error solutions
- [Limitations]({{ '/reference/limitations' | relative_url }}) - Known limitations
- [Configuration]({{ '/reference/configuration' | relative_url }}) - All options

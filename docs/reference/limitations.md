---
layout: default
title: Limitations
parent: Reference
nav_order: 2
---

# Limitations

This page documents known differences between Drizzle DuckDB and Drizzle's standard Postgres driver.

## Feature Support Matrix

| Feature              | Status  | Notes                                                                      |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| Select queries       | Full    | All standard select operations work                                        |
| Insert/Update/Delete | Full    | Including `.returning()`                                                   |
| Joins                | Full    | All join types supported; same-name columns auto-qualified                 |
| Subqueries           | Full    |                                                                            |
| CTEs (WITH clauses)  | Full    | Join column ambiguity auto-resolved                                        |
| Aggregations         | Full    |                                                                            |
| Transactions         | Partial | No savepoints (driver probes once, then falls back)                        |
| Concurrent queries   | Partial | One query per connection; use pooling for parallelism                      |
| Prepared statements  | Partial | No statement caching; no named statements                                  |
| JSON/JSONB columns   | None    | Use `duckDbJson()` instead                                                 |
| Streaming results    | Partial | Default materialized; use `executeBatches()` / `executeArrow()` for chunks |
| Relational queries   | Full    | With schema configuration                                                  |

## Transactions

### No Savepoint Support

DuckDB 1.4.x doesn't support `SAVEPOINT`, which means nested transactions behave differently. The driver attempts a savepoint once per dialect instance; after a syntax error it marks savepoints unsupported and reuses the outer transaction for nested calls.

```typescript
// In Postgres: inner rollback only affects inner transaction
// In DuckDB: inner rollback aborts the ENTIRE transaction

await db.transaction(async (tx) => {
  await tx.insert(users).values({ id: 1, name: 'Alice' });

  await tx.transaction(async (innerTx) => {
    await innerTx.insert(users).values({ id: 2, name: 'Bob' });
    // This rollback aborts EVERYTHING, including Alice
    innerTx.rollback();
  });
});
```

**Workaround:** Structure your code to avoid nested transactions, or handle rollback logic at the outer level. The driver will attempt a savepoint once per dialect instance; current DuckDB builds reject the syntax, so nested calls fall back to the outer transaction and mark it for rollback on errors.

## JSON Columns

### Postgres JSON/JSONB Not Supported

Using `json()` or `jsonb()` from `drizzle-orm/pg-core` will throw an error:

```typescript
import { json, jsonb } from 'drizzle-orm/pg-core';

// This will throw at runtime
const table = pgTable('example', {
  data: json('data'), // Error!
});
```

**Solution:** Use `duckDbJson()` instead:

```typescript
import { duckDbJson } from '@leonardovida-md/drizzle-neo-duckdb';

const table = pgTable('example', {
  data: duckDbJson('data'), // Works!
});
```

The driver checks for Postgres JSON columns and throws a descriptive error if found.

## Prepared Statements

### No Statement Caching

Unlike the Postgres driver, DuckDB doesn't cache prepared statements. Each query is prepared and executed fresh:

```typescript
// These execute as separate preparations
const result1 = await db.select().from(users).where(eq(users.id, 1));
const result2 = await db.select().from(users).where(eq(users.id, 2));
```

This has minimal performance impact for most workloads since DuckDB is optimized for analytical queries.

## Result Handling

### Materialized Results

All query results are fully materialized in memory by default.
Use `db.executeBatches()` to process rows in chunks without holding the entire result set, or `db.executeArrow()` when Arrow output is available:

```typescript
for await (const chunk of db.executeBatches(
  sql`select * from ${users} order by ${users.id}`,
  { rowsPerChunk: 50_000 } // default: 100_000
)) {
  // handle each chunk of rows
}
```

If your runtime exposes an Arrow/columnar API, `db.executeArrow()` will return it; otherwise it falls back to column-major arrays.

**For very large datasets:** Prefer server-side aggregation, `executeBatches()` for incremental reads, or add `LIMIT`/pagination when you genuinely need all rows.

### One Query Per Connection

DuckDB executes a single query at a time per connection. Without pooling, concurrent requests will serialize. The async `drizzle()` entrypoints auto-create a pool (default size: 4); configure size/presets with the `pool` option or use `createDuckDBConnectionPool` for timeouts, queue limits, and recycling.

## DuckLake Limitations

DuckLake supports `NOT NULL` constraints only. Primary keys, foreign keys, unique constraints, check constraints, and indexes are not supported. Avoid relying on those features when using DuckLake catalogs.

### Column Alias Deduplication

When selecting the same column multiple times (e.g., in multi-join queries), duplicate aliases are automatically suffixed to avoid collisions:

```typescript
const result = await db
  .select({
    userId: users.id,
    postId: posts.id, // Would conflict without deduplication
  })
  .from(users)
  .innerJoin(posts, eq(users.id, posts.userId));

// Columns are properly distinguished in results
```

## Date/Time Handling

### DuckDB Timestamp Semantics

DuckDB handles timestamps slightly differently than Postgres:

1. **No implicit timezone conversion** - Timestamps without timezone are stored as-is
2. **String format** - DuckDB uses space separator (`2024-01-15 10:30:00`) rather than `T`
3. **Offset normalization** - Timezone offsets like `+00` are handled correctly

The `duckDbTimestamp()` helper normalizes these differences:

```typescript
// Input: JavaScript Date or ISO string
await db.insert(events).values({
  createdAt: new Date('2024-01-15T10:30:00Z'),
});

// Output: Properly formatted for DuckDB queries
// SELECT ... WHERE created_at = TIMESTAMP '2024-01-15 10:30:00+00'
```

### Mode Options

```typescript
// Return Date objects (default)
duckDbTimestamp('col', { mode: 'date' });

// Return strings in DuckDB format
duckDbTimestamp('col', { mode: 'string' });
// Returns: '2024-01-15 10:30:00+00'
```

## Query Transformation

This driver automatically transforms certain SQL patterns to ensure compatibility with DuckDB. All transformation happens transparently at the dialect level when SQL is generated.

### How It Works

The driver uses an AST-based (Abstract Syntax Tree) SQL transformer that:

1. **Preserves correctness** - Only modifies patterns that would fail or behave incorrectly in DuckDB
2. **Maintains performance** - Parses SQL only when transformation patterns are detected
3. **Handles edge cases** - Proper AST parsing handles complex queries with CTEs, subqueries, etc.
4. **Falls back gracefully** - If the parser fails, the original SQL is used

Transformation is applied automatically in `DuckDBDialect.sqlToQuery()` for all queries.

### Array Operators

Postgres array operators are transformed to DuckDB functions:

| Postgres               | DuckDB Equivalent              |
| ---------------------- | ------------------------------ |
| `column @> ARRAY[...]` | `array_has_all(column, [...])` |
| `column <@ ARRAY[...]` | `array_has_all([...], column)` |
| `column && ARRAY[...]` | `array_has_any(column, [...])` |

This transformation happens automatically for all queries.

**Recommendation:** Use the explicit DuckDB-native helpers for clarity:

```typescript
import { arrayHasAll, arrayHasAny, duckDbArrayContains } from '@leonardovida-md/drizzle-neo-duckdb';

// DuckDB-native (recommended)
.where(arrayHasAll(products.tags, ['a', 'b']))

// Legacy helper (still works)
.where(duckDbArrayContains(products.tags, ['a', 'b']))

// Postgres operator (auto-transformed)
.where(arrayContains(products.tags, ['a', 'b']))
```

### String Array Literals

Postgres-style array literals like `'{1,2,3}'` are detected and logged as warnings:

```typescript
// This triggers a warning
await db.execute(sql`SELECT * FROM t WHERE tags = '{a,b,c}'`);
// Warning: Use duckDbList()/duckDbArray() or pass native arrays instead
```

To throw instead of warn:

```typescript
const db = drizzle(connection, {
  rejectStringArrayLiterals: true, // Throws on '{...}' literals
});
```

### JOIN Column Qualification

When joining tables or CTEs using `eq()` with the same column name on both sides, drizzle-orm generates unqualified column references like `ON "country" = "country"`. DuckDB rejects this as ambiguous.

The driver automatically qualifies these references:

```sql
-- Before: ON "country" = "country"
-- After:  ON "cte1"."country" = "cte2"."country"
```

This works for:

- Simple table joins
- CTE joins (including CTEs that reference other CTEs)
- Subqueries in FROM clauses with aliases
- Multiple sequential joins
- Table aliases (uses the alias, not the original table name)

Qualification only occurs when both sides are columns with the **same name** and neither is already qualified.

## Schema Features

### Sequences

DuckDB supports sequences, but with some differences:

- Sequences are schema-scoped
- The migration system creates sequences for tracking tables automatically
- `nextval()` and `currval()` work as expected

### Schemas

Custom schemas work, but DuckDB's default schema is `main` (not `public` like Postgres):

```typescript
// Works
const mySchema = pgSchema('analytics');
const table = mySchema.table('events', { ... });

// Default schema in DuckDB is 'main', not 'public'
```

## Performance Considerations

### Analytical vs OLTP

DuckDB is optimized for analytical workloads (OLAP), not transactional workloads (OLTP):

- **Good for:** Aggregations, scans, joins on large datasets
- **Less optimal for:** High-frequency single-row inserts/updates

For write-heavy workloads, consider batching:

```typescript
// Better: batch inserts
await db.insert(events).values(manyEvents);

// Less efficient: individual inserts in a loop
for (const event of manyEvents) {
  await db.insert(events).values(event); // Many round trips
}
```

### Memory Usage

Default selects materialize results. For very large result sets prefer `executeBatches()` or limit the result size:

```typescript
for await (const chunk of db.executeBatches(
  sql`select * from ${hugeTable} order by ${hugeTable.id}`,
  { rowsPerChunk: 10_000 }
)) {
  // process chunk
}
```

## Native Value Binding

### Future Work

Some column types use SQL literals rather than native DuckDB value bindings due to Bun/DuckDB compatibility issues:

- **`duckDbTimestamp`** - Uses SQL literals (e.g., `TIMESTAMP '2024-01-15 10:30:00+00'`) due to bigint handling differences between Bun and Node.js in the DuckDB native bindings
- **`duckDbStruct`** - Uses `struct_pack(...)` SQL literals to handle nested arrays correctly (empty arrays need type hints that native binding doesn't provide)
- **`duckDbDate`, `duckDbTime`, `duckDbInterval`** - Use passthrough binding

The following column types **do** use native DuckDB value bindings for improved performance:

- **`duckDbList`** - Uses `DuckDBListValue` for native array binding
- **`duckDbArray`** - Uses `DuckDBArrayValue` for native array binding
- **`duckDbMap`** - Uses `DuckDBMapValue` for native map binding
- **`duckDbBlob`** - Uses `DuckDBBlobValue` for native binary binding
- **`duckDbJson`** - Uses native string binding with delayed `JSON.stringify()`

### Bun Runtime Notes

When running under Bun, certain DuckDB native bindings behave differently than under Node.js. The driver handles these differences automatically by falling back to SQL literals where needed. All tests pass under both Bun and Node.js.

## Workarounds Summary

| Limitation               | Workaround                                              |
| ------------------------ | ------------------------------------------------------- |
| No savepoints            | Avoid nested transactions                               |
| No JSON/JSONB            | Use `duckDbJson()`                                      |
| No cursor streaming      | Use `executeBatches()` / `executeArrow()` or pagination |
| String array warnings    | Use native arrays or DuckDB helpers                     |
| Default schema is `main` | Explicitly use `pgSchema('main')` if needed             |
| CTE join ambiguity       | Automatic (or use different column names)               |

---
layout: default
title: Limitations
parent: Reference
nav_order: 2
---

# Limitations

This page documents known differences between Drizzle DuckDB and Drizzle's standard Postgres driver.

## Feature Support Matrix

| Feature                              | Status  | Notes                                                                                                                                              |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select queries                       | Full    | All standard select operations work                                                                                                                |
| Insert/Update/Delete                 | Full    | Including `.returning()`                                                                                                                           |
| Joins                                | Full    | All join types supported. Same-name columns are auto-qualified                                                                                     |
| Subqueries                           | Full    |                                                                                                                                                    |
| CTEs (WITH clauses)                  | Full    | Join column ambiguity auto-resolved                                                                                                                |
| Aggregations                         | Full    |                                                                                                                                                    |
| Transactions                         | Partial | No savepoints in current 1.4.x/1.5.x builds (driver probes once, then falls back). Transaction config is ignored                                   |
| Concurrent queries                   | Partial | One query per connection. Use pooling for parallelism                                                                                              |
| Prepared statements                  | Partial | Optional per-connection cache via `prepareCache`. No named statements                                                                              |
| JSON/JSONB columns                   | None    | Use `duckDbJson()` instead                                                                                                                         |
| `VARIANT` / `GEOMETRY` raw JS values | Partial | `VARIANT` materializes with `@duckdb/node-api@1.5.4-r.1` and newer. Project geometry with `ST_AsText(...)` or `ST_AsWKB(...)` for portable output. |
| Streaming results                    | Partial | Default materialized. Use `executeBatches()` for chunks                                                                                            |
| Relational queries                   | Full    | With schema configuration                                                                                                                          |

## Transactions

### No Savepoint Support

DuckDB 1.4.x and 1.5.x currently reject `SAVEPOINT`, which means nested transactions behave differently. The driver attempts a savepoint once per dialect instance. After a syntax error, it marks savepoints unsupported and reuses the outer transaction for nested calls.

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

**Workaround:** Structure your code to avoid nested transactions, or handle rollback logic at the outer level. When a nested call fails, the driver marks the outer transaction for rollback.

DuckDB also aborts the whole transaction when any statement fails. Catching the error does not keep earlier writes. Validate before writing, or run the risky write in its own `db.transaction()`. If a failed statement was caught inside the callback, `db.transaction()` rejects with `DuckDB aborted the transaction because a statement inside it failed. No changes were committed. ...` and the statement error as `cause`. Parser and catalog errors do not abort the transaction.

### Transaction Config Is Ignored (Deprecated)

DuckDB has no `SET TRANSACTION` statement. The `config` argument of `db.transaction(fn, config)` (`isolationLevel`, `accessMode`, `deferrable`) is ignored with a one-time warning: `Transaction config is not supported by DuckDB and is ignored. Passing it will throw in the next major version.` `DuckDBTransaction.setTransaction()` and `getTransactionConfigSQL()` are deprecated. See [Transactions]({{ '/core/transactions' | relative_url }}#transaction-config-deprecated).

## DuckDB 1.5 Core Types

DuckDB 1.5 adds native `VARIANT` and built-in `GEOMETRY` columns. With `@duckdb/node-api@1.5.4-r.1`, `VARIANT` values materialize into JavaScript values.

Use explicit projections when you need stable text or binary output:

```typescript
await db.execute(sql`
  select
    cast(data as varchar) as data_text,
    variant_extract(data, 'name') as name,
    ST_AsText(geom) as geom_wkt
  from my_table
`);
```

This driver does not provide first-class column helpers for raw `VARIANT` or `GEOMETRY` values yet.

If a result column has a type the installed `@duckdb/node-api` cannot convert, the query throws `DuckDB returned a column type that @duckdb/node-api cannot materialize to JavaScript ...` with the column names. Cast or project those columns as shown above.

## DECIMAL Precision

`DECIMAL` values come back as JavaScript numbers, so values with more than about 15 significant digits lose precision. A `numeric()` column returns the rounded number as a string. Cast to `VARCHAR` in SQL when you need the exact value:

```typescript
const rows = await db.execute(sql`
  select cast(amount as varchar) as amount_text from payments
`);
```

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
import { duckDbJson } from '@duckdbfan/drizzle-duckdb';

const table = pgTable('example', {
  data: duckDbJson('data'), // Works!
});
```

The driver checks for Postgres JSON columns and throws a descriptive error if found.

## Prepared Statements

### Optional Statement Caching

Prepared statements are not cached unless you enable the per-connection cache:

```typescript
const db = drizzle(connection, { prepareCache: { size: 32 } });
```

Cached executions on one connection run serially because binding mutates the
native prepared statement. Use a connection pool when queries need to run in
parallel.

## Result Handling

### Materialized Results

All query results are fully materialized in memory by default.
Use `db.executeBatches()` to process rows in chunks without holding the entire result set:

```typescript
for await (const chunk of db.executeBatches(
  sql`select * from ${users} order by ${users.id}`,
  { rowsPerChunk: 50_000 } // default: 100_000
)) {
  // handle each chunk of rows
}
```

`db.executeArrow()` materializes the whole result in column-major form. It returns an Arrow table only when the client result exposes an Arrow API. `@duckdb/node-api` does not, so with it you get JavaScript arrays keyed by column name.

**For very large datasets:** Prefer server-side aggregation, `executeBatches()` for incremental reads, or add `LIMIT`/pagination when you genuinely need all rows.

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

### One Query Per Connection

DuckDB executes a single query at a time per connection. Without pooling, concurrent requests will serialize. The async `drizzle()` entrypoints auto-create a pool (default size: 4). Configure size, presets, timeouts, queue limits, and recycling with the `pool` option, or use `createDuckDBConnectionPool` when you need a `setup` hook.

## DuckLake Limitations

DuckLake supports `NOT NULL` constraints only. Primary keys, foreign keys, unique constraints, check constraints, and indexes are not supported. Avoid relying on those features when using DuckLake catalogs.

## Date/Time Handling

### DuckDB Timestamp Semantics

DuckDB handles timestamps slightly differently than Postgres:

1. **No implicit timezone conversion**: timestamps without timezone are stored as-is
2. **String format**: DuckDB uses a space separator (`2024-01-15 10:30:00`) rather than `T`
3. **Offset normalization**: timezone offsets like `+00` are parsed when reading

The `duckDbTimestamp()` helper normalizes these differences:

```typescript
// Input: JavaScript Date or ISO string
await db.insert(events).values({
  createdAt: new Date('2024-01-15T10:30:00Z'),
});

// On Node.js the Date is bound as a native DuckDB timestamp parameter.
// On Bun, or when literal mode is forced, it becomes a SQL literal:
// TIMESTAMP '2024-01-15 10:30:00.000+00'
```

See [Native Value Binding](#native-value-binding) for when each path is used.

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

1. **Preserves correctness**: only modifies patterns that would fail or behave incorrectly in DuckDB
2. **Limits parsing cost**: parses SQL only when transformation patterns are detected. Plain `UPDATE`, `DELETE` and `ON CONFLICT DO UPDATE` statements are not parsed. Only `UPDATE ... FROM` is
3. **Handles nesting**: AST parsing covers queries with CTEs, subqueries, and similar structures
4. **Falls back**: if the parser fails, or the rewritten SQL would not keep every string literal, parameter and quoted identifier of the original, the original SQL runs as written. Queries with `IS [NOT] DISTINCT FROM` are never parsed, because the parser prints them back with a different meaning

Transformation is applied automatically in `DuckDBDialect.sqlToQuery()` for all queries.

### Array Operators

Postgres array operators are not rewritten. DuckDB supports them on `LIST` and fixed-size `ARRAY` values with the same results, including for `NULL` values:

| Postgres               | Same result as                 |
| ---------------------- | ------------------------------ |
| `column @> ARRAY[...]` | `array_has_all(column, [...])` |
| `column <@ ARRAY[...]` | `array_has_all([...], column)` |
| `column && ARRAY[...]` | `array_has_any(column, [...])` |

Only the first-dimension bounds helpers `array_lower(a, 1)` and `array_upper(a, 1)` are rewritten, because DuckDB does not have them.

All three styles work:

```typescript
import { arrayHasAll, arrayHasAny, duckDbArrayContains } from '@duckdbfan/drizzle-duckdb';

// DuckDB-native (recommended)
.where(arrayHasAll(products.tags, ['a', 'b']))

// Legacy helper (still works)
.where(duckDbArrayContains(products.tags, ['a', 'b']))

// Postgres operator (runs natively)
.where(arrayContains(products.tags, ['a', 'b']))
```

### String Array Literals

Strings bound to a column (inserts, updates, `eq(column, value)`) are stored and compared as written. Parameters without column information, meaning plain `sql` template parameters, `sql.param(...)` values and bare `sql.placeholder(...)` values, are checked for Postgres-style array literals such as `'{1,2,3}'`. Text written directly into the SQL string is not checked:

```typescript
// This triggers the check
await db.execute(sql`SELECT * FROM t WHERE scores = ${'{1,2,3}'}`);
```

A checked parameter is converted to a list when its contents parse as a JSON array after the braces become brackets (`'{1,2,3}'` becomes `[1, 2, 3]`). Strings such as `'{a,b,c}'` stay strings. Either way, the driver sends a warning through the configured logger, once per session:

```
[duckdb] Received a stringified Postgres-style array literal. Use duckDbList()/duckDbArray() or pass native arrays instead. You can also set rejectStringArrayLiterals=true to throw.
```

Pass `arrayLiteralWarning` to handle it yourself. To throw instead of warn:

```typescript
const db = drizzle(connection, {
  rejectStringArrayLiterals: true,
});
// Error: Stringified array literals are not supported. Use duckDbList()/duckDbArray() or pass native arrays.
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

### Timestamps

`duckDbTimestamp` columns of type `TIMESTAMP` or `TIMESTAMPTZ` bind as native DuckDB timestamp values on Node.js. They use SQL literals such as `TIMESTAMP '2024-01-15 10:30:00.000+00'` in these cases:

- The code runs on Bun, because of bigint handling differences in the DuckDB native bindings
- The `DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS` environment variable is set to any value other than `0`
- The column sets `bindMode: 'literal'`

`bindMode: 'bind'` forces native binding, including on Bun and when the environment variable is set. Columns with `duckDbType` set to `TIMESTAMP_S`, `TIMESTAMP_MS` or `TIMESTAMP_NS` always use literals.

### Other Column Types

Some column types use SQL literals rather than native DuckDB value bindings:

- **`duckDbStruct`**: uses `struct_pack(...)` SQL literals to handle nested arrays correctly (empty arrays need type hints that native binding doesn't provide)
- **`duckDbDate`, `duckDbTime`, `duckDbInterval`**: use passthrough binding

The following column types use native DuckDB value bindings:

- **`duckDbList`**: uses `DuckDBListValue` for native array binding. An empty list is sent as a typed literal such as `[]::VARCHAR[]`
- **`duckDbArray`**: uses `DuckDBArrayValue` for native array binding. An empty value is sent as a typed literal
- **`duckDbMap`**: uses `DuckDBMapValue` for native map binding. Empty maps, and maps with an empty list value, use a `map(...)` SQL literal
- **`duckDbBlob`**: uses `DuckDBBlobValue` for native binary binding
- **`duckDbJson`**: uses native string binding with delayed `JSON.stringify()`

## Workarounds Summary

| Limitation               | Workaround                                  |
| ------------------------ | ------------------------------------------- |
| No savepoints            | Avoid nested transactions                   |
| No JSON/JSONB            | Use `duckDbJson()`                          |
| No cursor streaming      | Use `executeBatches()` or pagination        |
| String array warnings    | Use native arrays or DuckDB helpers         |
| Default schema is `main` | Explicitly use `pgSchema('main')` if needed |
| CTE join ambiguity       | Automatic (or use different column names)   |
| DECIMAL precision        | Cast to `VARCHAR` in SQL for exact values   |
| Transaction config       | Remove it. DuckDB ignores it                |

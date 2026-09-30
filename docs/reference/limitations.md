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
| Joins                                | Full    | Builder fields are qualified. Raw SQL retains DuckDB's column ownership rules                                                                      |
| Subqueries                           | Full    | Fields are qualified by the subquery alias                                                                                                         |
| CTEs (WITH clauses)                  | Full    | Fields are qualified by the CTE name                                                                                                               |
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

A `numeric()` column returns the exact DECIMAL value as a string, as node-postgres does for NUMERIC. `numeric('amount', { precision: 38, scale: 10 })` keeps all 38 digits.

By default, other DECIMAL results use JavaScript numbers, which lose precision beyond about 15 significant digits. Set `decimalMode: 'string'` when creating the driver to preserve DECIMAL values in raw queries, nested lists, structs and maps, streaming and columnar reads. Relational results preserve numeric columns and decimal leaves in these nested column types before JSON serialization. SQL expressions returning DECIMAL use strings too, so their TypeScript annotations should reflect that policy. Explicit `mapWith(Number)`, numeric-mode columns and Number-based aggregate helpers still convert to a number. Relational SQL extras with unknown result types and numbers embedded in JSON require explicit casts, since their serialization cannot recover precision. Third-party Arrow providers control their own output conversion.

For a single expression, cast to `VARCHAR` in SQL:

```typescript
const rows = await db.execute(sql`
  select cast(amount as varchar) as amount_text from payments
`);
```

## Join compatibility

Raw SQL join expressions pass through without guessing which table owns an unqualified column. Builder selections retain qualified fields. Existing applications that relied on the old heuristic can opt in with `qualifyRawJoinColumns: true`, but explicitly qualifying ambiguous references is more reliable. For nullable joined objects, select a non-null key alongside nullable fields so a matched row whose selected values are all null can be distinguished from an unmatched row.

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

DuckDB prepares one statement at a time. SQL with several statements, or with
only comments, runs without the cache, so migrations without
`--> statement-breakpoint` markers also work with `prepareCache` on.

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

`db.executeArrow()` materializes the whole result in column-major form. It returns an Arrow table only when the client result exposes an Arrow API. `@duckdb/node-api` does not, so with it you get JavaScript arrays keyed by column name. Duplicate column names get the same suffixes as in `db.execute()`, so `select 1 as a, 2 as a` returns `{ a: [1], a_1: [2] }`.

While an `executeBatches()` loop is open, its connection cannot run other queries. See [executeBatches()]({{ '/api/database' | relative_url }}#executebatches).

### Result Value Types

Each result column is converted on its own. `TIMESTAMP_NS`, `TIME WITH TIME ZONE` and `TIME_NS` columns come back as DuckDB's text, which keeps precision a JavaScript value would lose. Other columns keep their JavaScript values, whatever else the query selects: `BLOB` is a `Buffer`, `BIGINT`, `HUGEINT` and `UBIGINT` are `bigint`, and `DATE` is a `Date`.

Raw `db.execute()` results use `@duckdb/node-api` values directly. `COUNT(*)` and `SUM` of an integer column return a `bigint`, `TIME` returns microseconds as a `bigint`, and `INTERVAL` returns `{ months, days, micros }`. Columns selected through the query builder use their column's decoder, for example `duckDbInterval()` returns interval text.

A SQL field uses its own `.mapWith()` decoder, even when it mentions a DuckDB column. ``sql`extract(hour from ${events.startTime})`.mapWith(Number)`` returns a number, not a TIME string. Only a bare ``sql`${column}` `` without `.mapWith()` uses the column's decoder.

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
// Returns: '2024-01-15 10:30:00'

duckDbTimestamp('col', { mode: 'string', withTimezone: true });
// Returns: '2024-01-15 10:30:00+00' (always UTC)
```

String mode usually keeps milliseconds only, because DuckDB returns timestamps to JavaScript as `Date` values. See [Timestamps, Dates, and Times]({{ '/api/columns' | relative_url }}#timestamps-dates-and-times).

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

Only the first-dimension bounds helpers `array_lower(a, 1)` and `array_upper(a, 1)` are rewritten, because DuckDB does not have them. The rewrite applies anywhere in the statement, including casts, `ARRAY[...]`, `ORDER BY`, `GROUP BY` and the `SET` and `WHERE` clauses of `UPDATE`.

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

### generate_series Aliases

Postgres lets you use a `generate_series` alias as a column. DuckDB treats the alias as a table, and names the column `generate_series`. The driver rewrites those references in `SELECT`, `WHERE`, `GROUP BY`, `ORDER BY` and `FILTER`:

```sql
-- Before: SELECT gs FROM generate_series(1, 3) AS gs GROUP BY gs
-- After:  SELECT "gs".generate_series AS "gs" FROM generate_series(1, 3) AS "gs" GROUP BY "gs".generate_series
```

A bare select item keeps its output name, so the result key is still `gs`.

### WITH Inside Set Operations

Drizzle can emit a `WITH` clause inside each arm of a `UNION`, `INTERSECT` or `EXCEPT`. DuckDB 1.4 has a binder bug for that shape, so the driver moves the arm CTEs into one top-level `WITH` when their names do not collide. The merged `WITH` is `RECURSIVE` when any arm uses `WITH RECURSIVE`. The driver leaves the SQL unchanged when an arm has its own `ORDER BY`, `LIMIT` or `OFFSET`, when a CTE name matches a table that another arm reads, or when a merged `RECURSIVE` would make a plain CTE read itself.

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

Stock drizzle-orm references an aliased field of a subquery or CTE by its bare alias, for example `ON "users"."id" = "id"`. DuckDB rejects that as ambiguous when another joined source has an `id` column.

Subqueries (`.as()`), CTEs (`$with`) and views built with this driver expose their fields qualified by the subquery alias, so the ON clause becomes `"users"."id" = "sq"."id"`.

For hand-written SQL, the driver also qualifies bare column references in JOIN ON clauses:

```sql
-- Before: ... FROM "users" LEFT JOIN "cte" ON "users"."id" = "id"
-- After:  ... FROM "users" LEFT JOIN "cte" ON "users"."id" = "cte"."id"
```

- The bare side of `qualified = bare` goes to the newly joined source, unless the qualified side already is that source. Then it goes to the earlier source when there is exactly one.
- `"id" = "id"` is qualified as earlier source and joined source, again only when there is exactly one earlier source.
- Other bare references to a same-name column in SELECT, WHERE, GROUP BY, HAVING and ORDER BY get the qualifier chosen in the ON clause. A name that got different qualifiers stays bare.
- USING columns are never qualified.
- Table aliases are used instead of the original table name, without the schema.

When the source cannot be decided, the SQL is left unchanged and DuckDB reports the ambiguous column. For example, `JOIN "c" ON "id" = "c"."id"` after two earlier sources stays as written. Qualify such columns yourself.

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
- The `DRIZZLE_DUCKDB_FORCE_LITERAL_TIMESTAMPS` environment variable is set to any non-empty value other than `0`
- The column sets `bindMode: 'literal'`

`bindMode: 'bind'` forces native binding, including on Bun and when the environment variable is set. Columns with `duckDbType` set to `TIMESTAMP_S`, `TIMESTAMP_MS` or `TIMESTAMP_NS` always use literals.

Both paths store the same value. Strings without an offset are UTC, and a naive `TIMESTAMP` string with an offset is converted to UTC, whatever the session `TimeZone`.

### Plain JavaScript Values

Values without a DuckDB column helper, such as `sql` template parameters, `sql.param(...)` values and pg-core columns, bind like this:

| Value                                             | Binds as                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Integer in the 32-bit range                       | `INTEGER`                                                                                                        |
| Integer outside the 32-bit range                  | `BIGINT`, so `3000000000` is stored as written                                                                   |
| Integer beyond `Number.MAX_SAFE_INTEGER`          | `DOUBLE`, because the number is no longer exact                                                                  |
| Other number                                      | `DOUBLE`                                                                                                         |
| `bigint`                                          | `HUGEINT`                                                                                                        |
| `Date`                                            | `TIMESTAMP` holding the UTC time. An invalid `Date` throws `Invalid Date parameter: cannot bind an invalid Date` |
| `Buffer` or `Uint8Array`                          | `BLOB`                                                                                                           |
| Array, for example ``sql`${sql.param([1, 2])}` `` | `LIST`, with the item type worked out from every item                                                            |

List item types come from all items, not the first one. `[null, 7, 8]` binds as `INTEGER[]`, `[1, 2.5]` as `DOUBLE[]` and `[1, 3e9]` as `BIGINT[]`. `duckDbList`, `duckDbArray` and `duckDbMap` values use the column's element or value type when the items fit it, and a `Date` inside a `TIMESTAMPTZ` list or map binds as a `TIMESTAMPTZ` value.

A JavaScript array written directly into a `sql` template, as in ``sql`${[1, 2]}` ``, is expanded by Drizzle into separate parameters. Wrap it in `sql.param()` to bind one list.

### Other Column Types

Some column types use SQL literals or plain string binding rather than native DuckDB values:

- **`duckDbStruct`**: uses `struct_pack(...)` SQL literals to handle nested arrays correctly (empty arrays need type hints that native binding doesn't provide)
- **`duckDbDate`, `duckDbTime`, `duckDbInterval`**: bind the value you pass without conversion, and DuckDB casts it to the column type

The following column types use native DuckDB value bindings:

- **`duckDbList`**: uses `DuckDBListValue` for native array binding. Empty lists, lists of structs or `Buffer` values, and lists whose inner lists are all empty are sent as typed literals such as `[]::VARCHAR[]`
- **`duckDbArray`**: uses `DuckDBArrayValue` for native array binding. The same values as for `duckDbList` are sent as typed literals
- **`duckDbMap`**: uses `DuckDBMapValue` for native map binding. Empty maps, and maps with struct, `Buffer` or empty list values, use a `map(...)` SQL literal
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
| DECIMAL precision        | Use `numeric()` or cast to `VARCHAR` in SQL |
| Transaction config       | Remove it. DuckDB ignores it                |

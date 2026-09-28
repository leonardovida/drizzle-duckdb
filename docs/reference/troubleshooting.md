---
layout: default
title: Troubleshooting
parent: Reference
nav_order: 4
---

# Troubleshooting

This guide covers common issues and their solutions when using Drizzle DuckDB.

## JSON Column Errors

### "Postgres JSON/JSONB columns are not supported"

**Symptom**: Runtime error when using `json()` or `jsonb()` from `drizzle-orm/pg-core`.

**Cause**: DuckDB has its own JSON type that works differently from Postgres.

**Solution**: Use `duckDbJson()` instead:

```typescript
// Wrong
import { json, jsonb } from 'drizzle-orm/pg-core';
const table = pgTable('t', { data: json('data') }); // Error!

// Correct
import { duckDbJson } from '@duckdbfan/drizzle-duckdb';
const table = pgTable('t', { data: duckDbJson('data') });
```

## Array Operator Issues

### Array operators fail with a conversion or binder error

**Symptom**: Queries using `@>`, `<@`, or `&&` operators fail.

**Cause**: DuckDB supports these operators on `LIST` and fixed-size `ARRAY` values, and the driver sends them unchanged. They fail when one side is not a list, for example a string such as `'{a,b}'` or a column that is not a list type.

**Solution**: Make both sides lists, for example with `duckDbList()` columns and JavaScript arrays. You can also use the explicit helpers, which emit `array_has_all` and `array_has_any`:

```typescript
import { duckDbArrayContains } from '@duckdbfan/drizzle-duckdb';

// Explicit and clear
.where(duckDbArrayContains(products.tags, ['a', 'b']))
```

### Warning about Postgres-style array literals

**Symptom**: The logger prints `[duckdb] Received a stringified Postgres-style array literal. Use duckDbList()/duckDbArray() or pass native arrays instead. You can also set rejectStringArrayLiterals=true to throw.`

**Cause**: A parameter without column information, such as a plain `sql` template value, an `sql.param(...)` value or a bare `sql.placeholder(...)`, looks like a Postgres array literal such as `'{1,2,3}'`. DuckDB lists use `[...]` syntax. The driver converts it to a list when its contents parse as a JSON array. Values bound to a column, such as inserts into a `text` column, are stored as written and do not trigger this warning. Text written directly into the SQL string is not checked either.

**Solution**: Use native JavaScript arrays or DuckDB list syntax:

```typescript
// Triggers the warning
await db.execute(sql`SELECT * FROM t WHERE tags = ${'{a,b,c}'}`);

// DuckDB list literal
await db.execute(sql`SELECT * FROM t WHERE tags = ['a', 'b', 'c']`);

// Bound JavaScript array
await db.execute(
  sql`SELECT * FROM t WHERE tags = ${sql.param(['a', 'b', 'c'])}`
);
```

To make this a hard error instead of a warning:

```typescript
const db = drizzle(connection, {
  rejectStringArrayLiterals: true,
});
// Error: Stringified array literals are not supported. Use duckDbList()/duckDbArray() or pass native arrays.
```

## Transaction Issues

### Nested transaction rollback aborts entire transaction

**Symptom**: Rolling back an inner transaction also rolls back the outer transaction.

**Cause**: DuckDB doesn't support `SAVEPOINT`, so nested transactions reuse the outer transaction.

**Solution**: Structure code to avoid nested transactions. DuckDB aborts the whole transaction when any statement fails. Catching the error does not keep earlier writes. Validate before writing, or run the risky write in its own `db.transaction()`:

```typescript
// Problematic pattern
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });
  await tx.transaction(async (innerTx) => {
    await innerTx.insert(users).values({ name: 'Bob' });
    innerTx.rollback(); // Aborts EVERYTHING
  });
});

// Better: commit Alice first, then run the risky write on its own
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });
});
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: 'Bob' });
  });
} catch (e) {
  // Alice is already committed
}
```

### "DuckDB aborted the transaction because a statement inside it failed"

**Symptom**: `db.transaction()` rejects with `DuckDB aborted the transaction because a statement inside it failed. No changes were committed. ...` even though your callback finished.

**Cause**: A statement inside the transaction failed and the callback caught the error. DuckDB aborts the whole transaction on a failed statement, so nothing can be committed. The original statement error is on `error.cause`.

**Solution**: Rethrow the statement error, or catch it outside `db.transaction()`. Validate data before writing, or move the risky write into its own `db.transaction()`. Parser and catalog errors, such as a SQL typo or a missing table, do not abort the transaction.

### "Transaction config is not supported by DuckDB and is ignored"

**Symptom**: A one-time console warning when calling `db.transaction(fn, config)`.

**Cause**: DuckDB has no `SET TRANSACTION`. Options such as `isolationLevel`, `accessMode` and `deferrable` are deprecated and ignored.

**Solution**: Remove the config argument. The next major version will throw when it is passed.

## Query Result Issues

### "DuckDB returned a column type that @duckdb/node-api cannot materialize to JavaScript"

**Symptom**: A query throws `DuckDB returned a column type that @duckdb/node-api cannot materialize to JavaScript for column "...". Cast those columns to a supported representation before selecting them, ...`.

**Cause**: The result has a column type the installed `@duckdb/node-api` cannot convert to a JavaScript value, such as some `VARIANT` or `GEOMETRY` values on older clients.

**Solution**: Cast or project the column in SQL, for example `CAST(col AS VARCHAR)`, `variant_extract(...)`, `ST_AsText(...)` or `ST_AsWKB(...)`.

### DECIMAL values lose precision

**Symptom**: Large `DECIMAL` values come back rounded.

**Cause**: `DECIMAL` results are returned as JavaScript numbers, which keep about 15 significant digits.

**Solution**: Cast to `VARCHAR` in SQL when you need the exact value, for example ``sql`CAST(${orders.total} AS VARCHAR)` ``, and parse it with a decimal library.

## Next.js Issues

### "Module parse failed" Error

**Symptom**:

```
Module parse failed: Unexpected character '...'
```

**Cause**: Webpack trying to parse native Node.js modules.

**Solution**: Add to `next.config.js`:

```javascript
// Next.js 15+
const nextConfig = {
  serverExternalPackages: ['@duckdb/node-api'],
};

// Next.js 14
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@duckdb/node-api'],
  },
};
```

When sharing generated schemas with client components (e.g., drizzle-zod or tRPC inputs), import column helpers from the browser-safe subpath to avoid bundling the native binding:

```ts
import { duckDbJson } from '@duckdbfan/drizzle-duckdb/helpers';
```

### "Native Node.js APIs not supported" Error

**Symptom**:

```
Native Node.js APIs are not supported in Edge Runtime
```

**Cause**: Trying to use DuckDB in an Edge function.

**Solution**: Ensure your route uses Node.js runtime:

```typescript
// app/api/data/route.ts
export const runtime = 'nodejs';
```

### GLIBCXX Errors on Vercel

**Symptom**:

```
Error: /lib64/libstdc++.so.6: version `GLIBCXX_3.4.26' not found
```

**Cause**: Vercel region doesn't have compatible C++ runtime.

**Solutions**:

- Deploy to a different Vercel region
- Use Docker-based deployment
- Consider using MotherDuck instead of local DuckDB

### Connection Not Cleaned Up in Serverless

**Symptom**: Memory leaks or stale connections in serverless functions.

**Solution**: Use a cleanup pattern:

```typescript
export async function withDb<T>(
  callback: (db: DuckDBDatabase) => Promise<T>
): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    return await callback(drizzle(connection));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
```

## Migration Issues

### "Migration already applied" Errors

**Symptom**: Migrations fail saying they're already applied, but database doesn't have expected schema.

**Cause**: Migration tracking table has records but tables were dropped.

**Solution**: Clear the tracking table:

```typescript
import { sql } from 'drizzle-orm';

await db.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
await migrate(db, './drizzle');
```

### Sequence Errors

**Symptom**: Errors about missing sequences during migration.

**Solution**: Manually create the required sequence:

```typescript
await db.execute(sql`
  CREATE SEQUENCE IF NOT EXISTS drizzle.__drizzle_migrations_id_seq
`);
```

### Schema Doesn't Exist

**Symptom**: Migration fails because schema doesn't exist.

**Solution**: Create the schema first:

```typescript
await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
await migrate(db, './drizzle');
```

### Postgres Syntax Not Compatible

**Symptom**: Drizzle Kit generated SQL fails in DuckDB.

**Common incompatibilities**:

- `SERIAL` type doesn't exist
- `JSONB` should be `JSON`
- Some constraint syntax differs

**Solution**: Review and adjust generated SQL:

```sql
-- Generated (Postgres)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  data JSONB
);

-- Fixed (DuckDB)
CREATE SEQUENCE IF NOT EXISTS users_id_seq;
CREATE TABLE users (
  id INTEGER PRIMARY KEY DEFAULT nextval('users_id_seq'),
  data JSON
);
```

## MotherDuck Issues

### Connection Timeout

**Symptom**: Connection to MotherDuck hangs or times out.

**Solutions**:

- Verify your `MOTHERDUCK_TOKEN` is valid
- Check network connectivity
- Ensure you're not behind a restrictive firewall

### Token Not Found

**Symptom**: Authentication errors when connecting to MotherDuck.

**Solution**: Ensure environment variable is set:

```typescript
const token = process.env.MOTHERDUCK_TOKEN;
if (!token) {
  throw new Error('MOTHERDUCK_TOKEN environment variable is required');
}

const instance = await DuckDBInstance.create('md:', {
  motherduck_token: token,
});
```

## Type Inference Issues

### Types Not Inferred Correctly

**Symptom**: TypeScript shows wrong types for query results.

**Solution**: Ensure you're passing schema to drizzle:

```typescript
import * as schema from './schema';

const db = drizzle(connection, { schema });

// Now relational queries have correct types
const users = await db.query.users.findMany();
```

### DuckDB-specific Types Show as `unknown`

**Symptom**: Columns with `duckDbList`, `duckDbStruct`, etc. show as `unknown`.

**Solution**: Provide generic type parameter:

```typescript
const table = pgTable('example', {
  tags: duckDbList<string>('tags', 'TEXT'),
  metadata: duckDbStruct<{ name: string; value: number }>('metadata', {
    name: 'TEXT',
    value: 'INTEGER',
  }),
});
```

## Performance Issues

### Slow Queries on Large Datasets

**Symptom**: Queries take longer than expected.

**Solutions**:

1. Use appropriate indexes
2. Add `LIMIT` clauses for large result sets
3. Consider using CTEs for multi-step queries
4. Profile with `EXPLAIN ANALYZE`

```typescript
// Profile a query
const explain = await db.execute(sql`
  EXPLAIN ANALYZE
  SELECT * FROM large_table WHERE category = 'electronics'
`);
console.log(explain);
```

### Memory Usage Too High

**Symptom**: Application runs out of memory.

**Cause**: Results are fully materialized in memory.

**Solution**: Stream the result with `db.executeBatches()` (see [DuckDBDatabase]({{ '/api/database' | relative_url }}#executebatches)), or use pagination:

```typescript
const pageSize = 1000;
let offset = 0;
let hasMore = true;

while (hasMore) {
  const batch = await db
    .select()
    .from(largeTable)
    .limit(pageSize)
    .offset(offset);

  // Process batch
  processBatch(batch);

  hasMore = batch.length === pageSize;
  offset += pageSize;
}
```

## See Also

- [Limitations]({{ '/reference/limitations' | relative_url }}): known limitations
- [FAQ]({{ '/reference/faq' | relative_url }}): frequently asked questions
- [Configuration]({{ '/reference/configuration' | relative_url }}): configuration options

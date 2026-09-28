---
layout: default
title: DuckDBDatabase
parent: API Reference
nav_order: 2
---

# DuckDBDatabase

The `DuckDBDatabase` class extends Drizzle's `PgDatabase` with DuckDB-specific handling. It's the main interface for executing queries.

## Class Overview

```typescript
class DuckDBDatabase<TFullSchema, TSchema> extends PgDatabase<
  DuckDBQueryResultHKT,
  TFullSchema,
  TSchema
> {
  select(): DuckDBSelectBuilder<undefined>;
  select<TSelection>(fields: TSelection): DuckDBSelectBuilder<TSelection>;
  insert<TTable>(table: TTable): InsertBuilder<TTable>;
  update<TTable>(table: TTable): UpdateBuilder<TTable>;
  delete<TTable>(table: TTable): DeleteBuilder<TTable>;
  execute<T>(query: SQL): Promise<T[]>;
  transaction<T>(
    fn: (tx: DuckDBTransaction) => Promise<T>,
    config?: PgTransactionConfig // deprecated, ignored
  ): Promise<T>;
  $with(alias: string): WithBuilder;

  // DuckDB additions
  executeBatches<T>(
    query: SQL,
    options?: { rowsPerChunk?: number }
  ): AsyncGenerator<T[]>;
  executeBatchesRaw(
    query: SQL,
    options?: { rowsPerChunk?: number }
  ): AsyncGenerator<{ columns: string[]; rows: unknown[][] }>;
  executeArrow(query: SQL): Promise<unknown>;
  close(): Promise<void>;

  readonly $client: DuckDBClientLike; // connection or pool
  readonly $instance?: DuckDBInstance; // set by the connection-string forms
}
```

## Methods

### select()

Execute a SELECT query.

```typescript
// Select all columns
const users = await db.select().from(usersTable);

// Select specific fields
const names = await db
  .select({ id: usersTable.id, name: usersTable.name })
  .from(usersTable);

// With WHERE clause
import { eq, and, gt } from 'drizzle-orm';

const activeUsers = await db
  .select()
  .from(usersTable)
  .where(eq(usersTable.active, true));

// With joins
const usersWithOrders = await db
  .select()
  .from(usersTable)
  .leftJoin(ordersTable, eq(usersTable.id, ordersTable.userId));
```

Selected columns that share a name, such as `id` from two joined tables, would collide in the result. The driver gives selected columns unique aliases so each field maps back correctly. This applies to `select()`, `selectDistinct()`, `selectDistinctOn()`, `with()` and `$with()`, on both `db` and the transaction object `tx`.

### insert()

Execute an INSERT query.

```typescript
// Insert single row
await db.insert(usersTable).values({
  name: 'Alice',
  email: 'alice@example.com',
});

// Insert multiple rows
await db.insert(usersTable).values([
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
]);

// Insert with returning
const [newUser] = await db
  .insert(usersTable)
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning();
```

### update()

Execute an UPDATE query.

```typescript
// Update with WHERE
await db
  .update(usersTable)
  .set({ name: 'New Name' })
  .where(eq(usersTable.id, 1));

// Update with returning
const [updated] = await db
  .update(usersTable)
  .set({ active: false })
  .where(eq(usersTable.id, 1))
  .returning();
```

### delete()

Execute a DELETE query.

```typescript
// Delete with WHERE
await db.delete(usersTable).where(eq(usersTable.id, 1));

// Delete with returning
const [deleted] = await db
  .delete(usersTable)
  .where(eq(usersTable.id, 1))
  .returning();
```

### execute()

Execute raw SQL queries.

```typescript
import { sql } from 'drizzle-orm';

// Execute DDL
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  )
`);

// Execute with type parameter
const result = await db.execute<{ count: number }>(
  sql`SELECT COUNT(*) as count FROM users`
);
console.log(result[0].count);

// Execute with parameters
const userId = 1;
const user = await db.execute<{ id: number; name: string }>(
  sql`SELECT * FROM users WHERE id = ${userId}`
);
```

### transaction()

Execute queries within a transaction.

```typescript
await db.transaction(async (tx) => {
  // All operations use the same transaction
  await tx.insert(usersTable).values({ name: 'Alice' });
  await tx
    .update(accountsTable)
    .set({ balance: sql`balance - 100` })
    .where(eq(accountsTable.userId, 1));
});
```

{: .warning }

> **Savepoint Limitation**
>
> DuckDB 1.4.x and 1.5.x do not support `SAVEPOINT`. Nested transactions reuse the outer transaction, and a rollback in a nested transaction aborts the entire transaction.

A statement that fails inside the callback aborts the DuckDB transaction. If you catch it and continue, `db.transaction()` rolls back and rejects with `DuckDB aborted the transaction because a statement inside it failed. ...`, with the statement error as `cause`.

The optional `config` argument (`isolationLevel`, `accessMode`, `deferrable`) is deprecated. DuckDB has no `SET TRANSACTION`, so the driver ignores it and prints a one-time warning. See [Transactions]({{ '/core/transactions' | relative_url }}).

```typescript
// This behaves differently than Postgres!
await db.transaction(async (tx) => {
  await tx.insert(usersTable).values({ name: 'Alice' });

  // Inner "transaction" reuses outer
  await tx.transaction(async (innerTx) => {
    await innerTx.insert(usersTable).values({ name: 'Bob' });
    // Rolling back here aborts EVERYTHING
    innerTx.rollback();
  });
});
// Neither Alice nor Bob are inserted
```

The transaction object `tx` also has `executeBatches()`, `executeBatchesRaw()` and `executeArrow()`. On a pool, all of them run on the connection pinned for the transaction.

### executeBatches()

Stream a query in chunks of row objects instead of materializing the whole result. `rowsPerChunk` defaults to 100,000. On a pool, one connection is held until the generator finishes.

```typescript
for await (const chunk of db.executeBatches<{ id: number }>(
  sql`select id from ${ordersTable} order by id`,
  { rowsPerChunk: 50_000 }
)) {
  console.log(chunk.length);
}
```

### executeBatchesRaw()

Same as `executeBatches()`, but each chunk is `{ columns, rows }` with rows as arrays. This skips building one object per row.

```typescript
for await (const { columns, rows } of db.executeBatchesRaw(
  sql`select * from ${ordersTable}`
)) {
  console.log(columns, rows.length);
}
```

### executeArrow()

Run a query and return columnar data. If the client result exposes an Arrow API (`toArrow()` or `getArrowTable()`), that result is returned. `@duckdb/node-api` does not expose one, so with it you get column-major JavaScript arrays:

```typescript
const columns = await db.executeArrow(sql`select 1 as a, 'x' as b`);
// { a: [1], b: ['x'] }
```

The return type is `unknown`. Cast it to the shape you expect.

### close()

Close the pool or connection in `$client`, then the DuckDB instance in `$instance` when one exists. Call it when you created the database with a connection string or `{ connection }`:

```typescript
const db = await drizzle('./app.duckdb');
try {
  // ...
} finally {
  await db.close();
}
```

If you passed your own client, `close()` closes that client too, but not the `DuckDBInstance` it came from.

### $client and $instance

`$client` is the connection or pool that queries run on. `$instance` is the `DuckDBInstance` the driver created for the connection-string forms. It is `undefined` when you passed your own client.

```typescript
const db = await drizzle(':memory:');
const pool = db.$client; // DuckDBConnectionPool
const instance = db.$instance; // DuckDBInstance
```

### $with()

Create Common Table Expressions (CTEs).

```typescript
// Define a CTE
const regionalSales = db.$with('regional_sales').as(
  db
    .select({
      region: ordersTable.region,
      totalSales: sql<number>`sum(${ordersTable.amount})`.as('total_sales'),
    })
    .from(ordersTable)
    .groupBy(ordersTable.region)
);

// Use the CTE
const result = await db
  .with(regionalSales)
  .select()
  .from(regionalSales)
  .where(gt(regionalSales.totalSales, 1000));
```

## Query Building

The database instance inherits all query building capabilities from Drizzle ORM:

```typescript
import { eq, and, or, gt, lt, like, inArray, sql } from 'drizzle-orm';

// Complex WHERE clauses
const results = await db
  .select()
  .from(usersTable)
  .where(
    and(
      eq(usersTable.active, true),
      or(gt(usersTable.age, 18), like(usersTable.role, '%admin%'))
    )
  );

// ORDER BY
const sorted = await db
  .select()
  .from(usersTable)
  .orderBy(desc(usersTable.createdAt));

// LIMIT and OFFSET
const page = await db.select().from(usersTable).limit(10).offset(20);

// GROUP BY and HAVING
import { count, sum, avg } from 'drizzle-orm';

const stats = await db
  .select({
    category: productsTable.category,
    totalProducts: count(),
    avgPrice: avg(productsTable.price),
  })
  .from(productsTable)
  .groupBy(productsTable.category)
  .having(gt(count(), 5));
```

## See Also

- [drizzle()]({{ '/api/drizzle' | relative_url }}): creating a database instance
- [Queries]({{ '/core/queries' | relative_url }}): query patterns guide
- [Transactions]({{ '/core/transactions' | relative_url }}): transaction handling

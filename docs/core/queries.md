---
layout: default
title: Queries
parent: Core Concepts
nav_order: 3
---

# Queries

Master Drizzle's query builder for DuckDB, including CTEs and aggregations.

## Basic Queries

### Select

```typescript
import { eq, and, or, gt, like, desc } from 'drizzle-orm';

// All rows
const allUsers = await db.select().from(users);

// Specific columns
const names = await db.select({ name: users.name }).from(users);

// With WHERE
const activeUsers = await db.select().from(users).where(eq(users.active, true));

// Multiple conditions
const results = await db
  .select()
  .from(users)
  .where(and(eq(users.active, true), gt(users.age, 18)));

// OR conditions
const results = await db
  .select()
  .from(users)
  .where(or(eq(users.role, 'admin'), eq(users.role, 'moderator')));
```

### Insert

```typescript
// Single row
await db.insert(users).values({
  name: 'Alice',
  email: 'alice@example.com',
});

// Multiple rows
await db.insert(users).values([
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
]);

// With returning
const [newUser] = await db
  .insert(users)
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning();
```

### Update

```typescript
await db.update(users).set({ active: false }).where(eq(users.id, 1));

// With returning
const [updated] = await db
  .update(users)
  .set({ name: 'Alice Smith' })
  .where(eq(users.id, 1))
  .returning();
```

### Delete

```typescript
await db.delete(users).where(eq(users.id, 1));

// With returning
const [deleted] = await db.delete(users).where(eq(users.id, 1)).returning();
```

## Joins

```typescript
// Inner join
const results = await db
  .select()
  .from(users)
  .innerJoin(orders, eq(users.id, orders.userId));

// Left join
const results = await db
  .select()
  .from(users)
  .leftJoin(orders, eq(users.id, orders.userId));

// Multiple joins
const results = await db
  .select({
    userName: users.name,
    orderTotal: orders.total,
    productName: products.name,
  })
  .from(orders)
  .leftJoin(users, eq(orders.userId, users.id))
  .leftJoin(products, eq(orders.productId, products.id));
```

## Aggregations

```typescript
import { count, sum, avg, min, max, countDistinct } from 'drizzle-orm';
import { countN, sumN, avgN, sumDistinctN } from '@duckdbfan/drizzle-duckdb';

// Basic aggregates
const stats = await db
  .select({
    totalUsers: count(),
    totalRevenue: sum(orders.total),
    avgOrder: avg(orders.total),
    minOrder: min(orders.total),
    maxOrder: max(orders.total),
  })
  .from(orders);

// COUNT DISTINCT
const uniqueCustomers = await db
  .select({
    uniqueCustomers: countDistinct(orders.userId),
  })
  .from(orders);

// GROUP BY
const revenueByCategory = await db
  .select({
    category: products.category,
    totalRevenue: sum(orders.total),
    orderCount: count(),
  })
  .from(orders)
  .leftJoin(products, eq(orders.productId, products.id))
  .groupBy(products.category);

// GROUP BY with HAVING
const bigCategories = await db
  .select({
    category: products.category,
    totalRevenue: sum(orders.total),
  })
  .from(orders)
  .leftJoin(products, eq(orders.productId, products.id))
  .groupBy(products.category)
  .having(gt(sum(orders.total), 10000));
```

### Numeric OLAP helpers

DuckDB returns DECIMAL aggregates as strings by default. Use the OLAP helpers to coerce to numbers when that trade-off is acceptable:

```typescript
const totals = await db
  .select({
    ordersTotal: sumN(orders.total), // number
    avgOrder: avgN(orders.total), // number
    uniqueCustomers: countN(), // number
    distinctTotal: sumDistinctN(orders.total), // number
  })
  .from(orders);
```

### Percentiles and window functions

```typescript
import {
  percentileCont,
  median,
  rowNumber,
  lag,
} from '@duckdbfan/drizzle-duckdb';

const [stats] = await db
  .select({
    p90: percentileCont(0.9, orders.total),
    med: median(orders.total),
    rn: rowNumber({ orderBy: orders.createdAt }),
    prevTotal: lag<number>(orders.total, 1, sql`0`, {
      orderBy: orders.createdAt,
    }),
  })
  .from(orders);
```

### Grouped measures with the OLAP builder

```typescript
import { olap, sumN } from '@duckdbfan/drizzle-duckdb';

const rows = await olap(db)
  .from(orders)
  .groupBy([orders.region])
  .selectNonAggregates(
    { sampleCustomer: orders.customerId },
    { anyValue: true }
  )
  .measures({
    revenue: sumN(orders.total),
    units: sumN(orders.quantity),
  })
  .orderBy(orders.region)
  .run();
```

## Common Table Expressions (CTEs)

```typescript
// Define a CTE
const regionalSales = db.$with('regional_sales').as(
  db
    .select({
      region: orders.region,
      totalSales: sum(orders.total).as('total_sales'),
    })
    .from(orders)
    .groupBy(orders.region)
);

// Use the CTE
const topRegions = await db
  .with(regionalSales)
  .select()
  .from(regionalSales)
  .where(gt(regionalSales.totalSales, 1000))
  .orderBy(desc(regionalSales.totalSales));
```

## Working with large result sets

Results are still materialized by default, but you can stream them in chunks to avoid loading everything into JS memory:

```typescript
for await (const chunk of db.executeBatches(
  sql`select * from ${orders} order by ${orders.id}`,
  { rowsPerChunk: 50_000 } // default: 100_000
)) {
  // handle each chunk of rows here
}
```

If your runtime exposes an Arrow/columnar interface, `db.executeArrow(sql\`...\`)` will return it; otherwise it falls back to column-major arrays.

### Multiple CTEs

```typescript
const cte1 = db.$with('top_products').as(
  db
    .select({ productId: orders.productId, total: sum(orders.total) })
    .from(orders)
    .groupBy(orders.productId)
    .orderBy(desc(sum(orders.total)))
    .limit(10)
);

const cte2 = db.$with('product_details').as(
  db
    .select()
    .from(products)
    .where(inArray(products.id, db.select({ id: cte1.productId }).from(cte1)))
);

const result = await db.with(cte1, cte2).select().from(cte2);
```

## Subqueries

```typescript
// Subquery in FROM
const subquery = db
  .select({
    userId: orders.userId,
    totalSpent: sum(orders.total).as('total_spent'),
  })
  .from(orders)
  .groupBy(orders.userId)
  .as('user_totals');

const topSpenders = await db
  .select({
    name: users.name,
    totalSpent: subquery.totalSpent,
  })
  .from(users)
  .innerJoin(subquery, eq(users.id, subquery.userId))
  .orderBy(desc(subquery.totalSpent));

// Subquery in WHERE
const usersWithOrders = await db
  .select()
  .from(users)
  .where(inArray(users.id, db.select({ userId: orders.userId }).from(orders)));
```

## Set Operations

```typescript
import { union, unionAll, intersect, except } from 'drizzle-orm/pg-core';

// UNION (removes duplicates)
const allEmails = await union(
  db.select({ email: users.email }).from(users),
  db.select({ email: subscribers.email }).from(subscribers)
);

// UNION ALL (keeps duplicates)
const allEmailsWithDupes = await unionAll(
  db.select({ email: users.email }).from(users),
  db.select({ email: subscribers.email }).from(subscribers)
);

// INTERSECT
const commonEmails = await intersect(
  db.select({ email: users.email }).from(users),
  db.select({ email: subscribers.email }).from(subscribers)
);

// EXCEPT
const usersNotSubscribed = await except(
  db.select({ email: users.email }).from(users),
  db.select({ email: subscribers.email }).from(subscribers)
);
```

## Window Functions (via SQL)

DuckDB supports window functions. Use raw SQL for complex patterns:

```typescript
import { sql } from 'drizzle-orm';

const ranked = await db.execute(sql`
  SELECT
    user_id,
    order_date,
    total,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY order_date) as order_num,
    SUM(total) OVER (PARTITION BY user_id ORDER BY order_date) as running_total,
    LAG(total) OVER (PARTITION BY user_id ORDER BY order_date) as prev_order
  FROM orders
  ORDER BY user_id, order_date
`);
```

## Ordering and Pagination

```typescript
// ORDER BY
const sorted = await db.select().from(users).orderBy(asc(users.name));

// Multiple columns
const sorted = await db
  .select()
  .from(users)
  .orderBy(desc(users.createdAt), asc(users.name));

// LIMIT and OFFSET
const page = await db
  .select()
  .from(users)
  .orderBy(users.id)
  .limit(10)
  .offset(20);
```

## Raw SQL

```typescript
import { sql } from 'drizzle-orm';

// Execute raw SQL
await db.execute(sql`
  CREATE INDEX idx_users_email ON users(email)
`);

// Query with type annotation
const result = await db.execute<{ count: number }>(
  sql`SELECT COUNT(*) as count FROM users WHERE active = true`
);

// Parameters
const userId = 1;
const user = await db.execute(sql`SELECT * FROM users WHERE id = ${userId}`);

// SQL fragments in queries
const results = await db
  .select({
    name: users.name,
    upperName: sql<string>`UPPER(${users.name})`,
  })
  .from(users);
```

## Performance Tips

### Batch Inserts

```typescript
// Good: Single batch
await db.insert(users).values(manyUsers);

// Bad: Many round trips
for (const user of manyUsers) {
  await db.insert(users).values(user);
}
```

### Use LIMIT

```typescript
// Always limit large result sets
const page = await db.select().from(largeTable).limit(100);
```

### Profile Queries

```typescript
const explain = await db.execute(sql`
  EXPLAIN ANALYZE
  SELECT * FROM users WHERE active = true
`);
console.log(explain);
```

## See Also

- [DuckDBDatabase]({{ '/api/database' | relative_url }}) - All database methods
- [Transactions]({{ '/core/transactions' | relative_url }}) - Transaction handling
- [Array Operations]({{ '/core/arrays' | relative_url }}) - Array queries

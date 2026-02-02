---
layout: default
title: Analytics Dashboard
parent: Examples
nav_order: 1
---

# Analytics Dashboard Example

This example shows an analytics dashboard with multi-table schemas, DuckDB-specific types, transactions, and analytical queries.

**Source**: [example/analytics-dashboard.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/analytics-dashboard.ts)

## Features Demonstrated

- Multi-table schema with foreign key relationships
- DuckDB-specific column types (STRUCT, LIST, MAP, JSON)
- Transactions for data integrity
- Complex aggregations and window functions
- Array operations with DuckDB helpers
- Loading and querying Parquet files

## Schema Definition

The example defines four related tables:

```typescript
import {
  pgTable,
  integer,
  text,
  doublePrecision,
  boolean,
  serial,
} from 'drizzle-orm/pg-core';
import {
  duckDbList,
  duckDbStruct,
  duckDbMap,
  duckDbJson,
  duckDbTimestamp,
} from '@leonardovida-md/drizzle-neo-duckdb';

// Users with JSON metadata and list of tags
const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  metadata: duckDbJson<{
    signupSource: string;
    referralCode?: string;
    preferences: { theme: string; notifications: boolean };
  }>('metadata'),
  tags: duckDbList<string>('tags', 'VARCHAR'),
  createdAt: duckDbTimestamp('created_at', { withTimezone: true }),
});

// Products with STRUCT attributes and MAP inventory
const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  price: doublePrecision('price').notNull(),
  attributes: duckDbStruct<{
    brand: string;
    color: string;
    weight: number;
  }>('attributes', {
    brand: 'VARCHAR',
    color: 'VARCHAR',
    weight: 'DOUBLE',
  }),
  inventory: duckDbMap<Record<string, number>>('inventory', 'INTEGER'),
  isActive: boolean('is_active').default(true),
});

// Orders with JSON items and STRUCT shipping address
const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status').notNull(),
  items:
    duckDbJson<
      Array<{ productId: number; quantity: number; unitPrice: number }>
    >('items'),
  totalAmount: doublePrecision('total_amount').notNull(),
  shippingAddress: duckDbStruct<{
    street: string;
    city: string;
    country: string;
    postalCode: string;
  }>('shipping_address', {
    street: 'VARCHAR',
    city: 'VARCHAR',
    country: 'VARCHAR',
    postalCode: 'VARCHAR',
  }),
  orderedAt: duckDbTimestamp('ordered_at', { withTimezone: true }),
});

// Analytics events
const events = pgTable('events', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  eventType: text('event_type').notNull(),
  eventData: duckDbJson<Record<string, unknown>>('event_data'),
  tags: duckDbList<string>('tags', 'VARCHAR'),
  timestamp: duckDbTimestamp('timestamp', { withTimezone: true }),
});
```

## Setting Up the Database

Create tables with sequences for auto-increment. Pick a connection style:

```typescript
// Single connection (matches the checked-in script)
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const db = drizzle(connection);
```

```typescript
// Auto-pooling for concurrent workloads (default pool size: 4, memory preset)
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

const db = await drizzle(':memory:', { pool: 'memory' });
```

```typescript
// Create sequences for serial columns
await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS users_id_seq`);
await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS products_id_seq`);

// Create tables with DuckDB-specific types
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY DEFAULT nextval('users_id_seq'),
    email VARCHAR NOT NULL UNIQUE,
    name VARCHAR NOT NULL,
    metadata JSON,
    tags VARCHAR[],
    created_at TIMESTAMPTZ
  )
`);

await db.execute(sql`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY DEFAULT nextval('products_id_seq'),
    name VARCHAR NOT NULL,
    category VARCHAR NOT NULL,
    price DOUBLE NOT NULL,
    attributes STRUCT(brand VARCHAR, color VARCHAR, weight DOUBLE),
    inventory MAP(VARCHAR, INTEGER),
    is_active BOOLEAN DEFAULT true
  )
`);
```

## Inserting Data with Transactions

Use transactions for data integrity (transactions pin a single pooled connection automatically):

```typescript
await db.transaction(async (tx) => {
  // Insert users
  await tx.insert(users).values([
    {
      email: 'alice@example.com',
      name: 'Alice Johnson',
      metadata: {
        signupSource: 'organic',
        preferences: { theme: 'dark', notifications: true },
      },
      tags: ['premium', 'early-adopter', 'newsletter'],
      createdAt: new Date('2024-01-15T10:30:00Z'),
    },
    {
      email: 'bob@example.com',
      name: 'Bob Smith',
      metadata: {
        signupSource: 'referral',
        referralCode: 'ALICE2024',
        preferences: { theme: 'light', notifications: false },
      },
      tags: ['standard', 'newsletter'],
      createdAt: new Date('2024-02-20T14:15:00Z'),
    },
  ]);

  // Insert products with STRUCT and MAP
  await tx.insert(products).values([
    {
      name: 'Wireless Headphones',
      category: 'Electronics',
      price: 149.99,
      attributes: { brand: 'AudioTech', color: 'black', weight: 0.25 },
      inventory: { warehouse_a: 150, warehouse_b: 75 },
    },
  ]);
});
```

## Array Operations

Find users by tags using DuckDB array helpers:

```typescript
import {
  duckDbArrayContains,
  duckDbArrayOverlaps,
} from '@leonardovida-md/drizzle-neo-duckdb';

// Find users with BOTH 'premium' AND 'newsletter' tags
const premiumNewsletterUsers = await db
  .select({ name: users.name, email: users.email, tags: users.tags })
  .from(users)
  .where(duckDbArrayContains(users.tags, ['premium', 'newsletter']));

// Find users with ANY of these tags
const specialUsers = await db
  .select({ name: users.name, tags: users.tags })
  .from(users)
  .where(duckDbArrayOverlaps(users.tags, ['premium', 'beta-tester']));
```

## Aggregations with Joins

Calculate order statistics per user:

```typescript
import { count, sum, avg, desc, eq } from 'drizzle-orm';

const orderStats = await db
  .select({
    userName: users.name,
    totalOrders: count(orders.id),
    totalSpent: sum(orders.totalAmount),
    avgOrderValue: avg(orders.totalAmount),
  })
  .from(users)
  .leftJoin(orders, eq(users.id, orders.userId))
  .groupBy(users.name)
  .orderBy(desc(sum(orders.totalAmount)));
```

## Window Functions and CTEs

Analyze user event funnels:

```typescript
const funnelAnalysis = await db.execute(sql`
  WITH user_events AS (
    SELECT
      user_id,
      event_type,
      timestamp,
      LAG(event_type) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_event,
      LAG(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as prev_timestamp
    FROM events
    WHERE user_id IS NOT NULL
  )
  SELECT
    event_type,
    COUNT(*) as event_count,
    COUNT(CASE WHEN prev_event = 'page_view' AND event_type = 'add_to_cart' THEN 1 END) as from_page_view,
    COUNT(CASE WHEN prev_event = 'add_to_cart' AND event_type = 'purchase' THEN 1 END) as from_cart
  FROM user_events
  GROUP BY event_type
  ORDER BY event_count DESC
`);
```

## STRUCT Field Access

Query revenue by shipping city:

```typescript
const revenueByCity = await db.execute(sql`
  SELECT
    shipping_address['city'] as city,
    shipping_address['country'] as country,
    COUNT(*) as order_count,
    SUM(total_amount) as total_revenue,
    AVG(total_amount) as avg_order_value
  FROM orders
  GROUP BY shipping_address['city'], shipping_address['country']
  ORDER BY total_revenue DESC
`);
```

## Parquet File Operations

Export to and query from Parquet:

```typescript
// Export query results to Parquet
await db.execute(sql`
  COPY (
    SELECT u.name as customer_name, o.total_amount, o.status, o.ordered_at
    FROM orders o
    JOIN users u ON o.user_id = u.id
  ) TO '/tmp/orders_export.parquet' (FORMAT PARQUET)
`);

// Query Parquet file directly
const parquetData = await db.execute(sql`
  SELECT * FROM read_parquet('/tmp/orders_export.parquet')
  ORDER BY total_amount DESC
`);
```

## JSON Field Analysis

Extract and aggregate JSON data:

```typescript
const preferencesAnalysis = await db.execute(sql`
  SELECT
    metadata->>'signupSource' as signup_source,
    COUNT(*) as user_count,
    COUNT(CASE WHEN metadata->'preferences'->>'theme' = 'dark' THEN 1 END) as dark_theme_users,
    COUNT(CASE WHEN (metadata->'preferences'->>'notifications')::boolean = true THEN 1 END) as notifications_enabled
  FROM users
  GROUP BY metadata->>'signupSource'
`);
```

## Running the Example

```bash
# Clone and install
git clone https://github.com/leonardovida/drizzle-duckdb.git
cd drizzle-duckdb
bun install

# Run the example
bun run example/analytics-dashboard.ts
```

## Cleanup

- Auto-pooling (`drizzle(':memory:', { pool: ... })`): call `await db.close()` when your app shuts down to close the pool and DuckDB instance.
- Single-connection script (the checked-in example): closes the connection/instance manually inside the script.

## Key Takeaways

1. **DuckDB Types**: Use STRUCT for nested objects, MAP for key-value pairs, LIST for arrays
2. **Type Safety**: Generic type parameters provide full TypeScript inference
3. **Transactions**: Wrap related operations for data integrity
4. **Analytical Queries**: DuckDB excels at aggregations, window functions, and CTEs
5. **Parquet Integration**: DuckDB can read/write Parquet files directly

## See Also

- [Column Types]({{ '/api/columns' | relative_url }}) - All available column types
- [Array Helpers]({{ '/api/array-helpers' | relative_url }}) - Array query functions
- [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}) - DuckDB-specific type guide

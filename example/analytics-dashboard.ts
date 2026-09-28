/**
 * Analytics Dashboard Example
 *
 * This example demonstrates a more complex use case of @duckdbfan/drizzle-duckdb
 * with @duckdb/node-api, showcasing:
 *
 * - Multiple related tables with foreign key relationships
 * - DuckDB-specific column types (STRUCT, LIST, MAP, JSON)
 * - Transactions for data integrity
 * - Complex aggregations and window functions
 * - Loading and querying Parquet files directly
 * - Array operations with DuckDB helpers
 *
 * Note: This example uses a single connection for simplicity.
 * For production use with concurrent queries, use connection pooling:
 *
 *   const db = await drizzle({
 *     connection: ':memory:',
 *     pool: 'memory', // or { size: 4 }
 *   });
 */

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drizzle,
  duckDbList,
  duckDbStruct,
  duckDbMap,
  duckDbJson,
  duckDbTimestamp,
  duckDbArrayContains,
  duckDbArrayOverlaps,
} from '../src/index.ts';
import { sql, eq, desc, count, avg, sum } from 'drizzle-orm';
import {
  pgTable,
  integer,
  text,
  doublePrecision,
  boolean,
  serial,
} from 'drizzle-orm/pg-core';

// Schema definitions

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

// Order item type for type safety
type OrderItem = { productId: number; quantity: number; unitPrice: number };

const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  status: text('status').notNull(),
  // Store order items as JSON for complex nested structures
  items: duckDbJson<OrderItem[]>('items'),
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

const events = pgTable('events', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  eventType: text('event_type').notNull(),
  eventData: duckDbJson<Record<string, unknown>>('event_data'),
  tags: duckDbList<string>('tags', 'VARCHAR'),
  timestamp: duckDbTimestamp('timestamp', { withTimezone: true }),
});

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  let connection: DuckDBConnection | undefined;

  try {
    connection = await instance.connect();
    const db = drizzle(connection);

    console.log('Creating schema...\n');

    // Create tables with sequences for auto-increment
    await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS users_id_seq`);
    await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS products_id_seq`);
    await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS orders_id_seq`);
    await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS events_id_seq`);

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

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY DEFAULT nextval('orders_id_seq'),
        user_id INTEGER NOT NULL REFERENCES users(id),
        status VARCHAR NOT NULL,
        items JSON,
        total_amount DOUBLE NOT NULL,
        shipping_address STRUCT(street VARCHAR, city VARCHAR, country VARCHAR, postalCode VARCHAR),
        ordered_at TIMESTAMPTZ
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY DEFAULT nextval('events_id_seq'),
        user_id INTEGER REFERENCES users(id),
        event_type VARCHAR NOT NULL,
        event_data JSON,
        tags VARCHAR[],
        timestamp TIMESTAMPTZ
      )
    `);

    // Insert sample data using transactions
    console.log('Inserting sample data in a transaction...\n');

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
        {
          email: 'carol@example.com',
          name: 'Carol Williams',
          metadata: {
            signupSource: 'ad-campaign',
            preferences: { theme: 'auto', notifications: true },
          },
          tags: ['premium', 'beta-tester'],
          createdAt: new Date('2024-03-10T09:00:00Z'),
        },
      ]);

      // Insert products
      await tx.insert(products).values([
        {
          name: 'Wireless Headphones',
          category: 'Electronics',
          price: 149.99,
          attributes: { brand: 'AudioTech', color: 'black', weight: 0.25 },
          inventory: { warehouse_a: 150, warehouse_b: 75 },
        },
        {
          name: 'Running Shoes',
          category: 'Sports',
          price: 89.99,
          attributes: { brand: 'SpeedRun', color: 'blue', weight: 0.4 },
          inventory: { warehouse_a: 200, warehouse_b: 120, warehouse_c: 80 },
        },
        {
          name: 'Coffee Maker',
          category: 'Home',
          price: 79.99,
          attributes: { brand: 'BrewMaster', color: 'silver', weight: 2.5 },
          inventory: { warehouse_a: 50 },
        },
        {
          name: 'Laptop Stand',
          category: 'Electronics',
          price: 49.99,
          attributes: { brand: 'DeskPro', color: 'gray', weight: 1.2 },
          inventory: { warehouse_a: 300, warehouse_b: 150 },
        },
      ]);
    });

    // Get user and product IDs for orders
    const allUsers = await db.select({ id: users.id }).from(users);
    const allProducts = await db
      .select({ id: products.id, price: products.price })
      .from(products);

    // Insert orders
    console.log('Inserting orders...\n');
    await db.insert(orders).values([
      {
        userId: allUsers[0]!.id,
        status: 'delivered',
        items: [
          {
            productId: allProducts[0]!.id,
            quantity: 1,
            unitPrice: allProducts[0]!.price,
          },
          {
            productId: allProducts[3]!.id,
            quantity: 2,
            unitPrice: allProducts[3]!.price,
          },
        ],
        totalAmount: 249.97,
        shippingAddress: {
          street: '123 Main St',
          city: 'New York',
          country: 'USA',
          postalCode: '10001',
        },
        orderedAt: new Date('2024-03-01T11:00:00Z'),
      },
      {
        userId: allUsers[1]!.id,
        status: 'processing',
        items: [
          {
            productId: allProducts[1]!.id,
            quantity: 1,
            unitPrice: allProducts[1]!.price,
          },
        ],
        totalAmount: 89.99,
        shippingAddress: {
          street: '456 Oak Ave',
          city: 'Los Angeles',
          country: 'USA',
          postalCode: '90001',
        },
        orderedAt: new Date('2024-03-15T16:30:00Z'),
      },
      {
        userId: allUsers[0]!.id,
        status: 'shipped',
        items: [
          {
            productId: allProducts[2]!.id,
            quantity: 1,
            unitPrice: allProducts[2]!.price,
          },
        ],
        totalAmount: 79.99,
        shippingAddress: {
          street: '123 Main St',
          city: 'New York',
          country: 'USA',
          postalCode: '10001',
        },
        orderedAt: new Date('2024-03-20T08:45:00Z'),
      },
    ]);

    // Insert analytics events
    console.log('Inserting analytics events...\n');
    await db.insert(events).values([
      {
        userId: allUsers[0]!.id,
        eventType: 'page_view',
        eventData: { page: '/products', duration: 45 },
        tags: ['web', 'browsing'],
        timestamp: new Date('2024-03-01T10:55:00Z'),
      },
      {
        userId: allUsers[0]!.id,
        eventType: 'add_to_cart',
        eventData: { productId: allProducts[0]!.id, quantity: 1 },
        tags: ['web', 'conversion'],
        timestamp: new Date('2024-03-01T10:58:00Z'),
      },
      {
        userId: allUsers[0]!.id,
        eventType: 'purchase',
        eventData: { orderId: 1, amount: 249.97 },
        tags: ['web', 'conversion', 'revenue'],
        timestamp: new Date('2024-03-01T11:00:00Z'),
      },
      {
        userId: allUsers[1]!.id,
        eventType: 'page_view',
        eventData: { page: '/sports', duration: 120 },
        tags: ['mobile', 'browsing'],
        timestamp: new Date('2024-03-15T16:00:00Z'),
      },
      {
        userId: allUsers[2]!.id,
        eventType: 'signup',
        eventData: { source: 'ad-campaign', campaign: 'spring-2024' },
        tags: ['web', 'acquisition'],
        timestamp: new Date('2024-03-10T09:00:00Z'),
      },
    ]);

    // Query examples
    console.log('='.repeat(60));
    console.log('QUERY EXAMPLES');
    console.log('='.repeat(60));

    // 1. Find premium users with newsletter subscription using array operations
    console.log('\n1. Premium users subscribed to newsletter:');
    const premiumNewsletterUsers = await db
      .select({
        name: users.name,
        email: users.email,
        tags: users.tags,
      })
      .from(users)
      .where(duckDbArrayContains(users.tags, ['premium', 'newsletter']));

    console.table(premiumNewsletterUsers);

    // 2. Find users with any premium-related tag
    console.log('\n2. Users with premium OR beta-tester tags:');
    const specialUsers = await db
      .select({
        name: users.name,
        tags: users.tags,
      })
      .from(users)
      .where(duckDbArrayOverlaps(users.tags, ['premium', 'beta-tester']));

    console.table(specialUsers);

    // 3. Aggregate order statistics by user
    console.log('\n3. Order statistics by user:');
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

    console.table(
      orderStats.map((row) => ({
        userName: row.userName,
        totalOrders: Number(row.totalOrders),
        totalSpent: row.totalSpent
          ? `$${Number(row.totalSpent).toFixed(2)}`
          : '$0.00',
        avgOrderValue: row.avgOrderValue
          ? `$${Number(row.avgOrderValue).toFixed(2)}`
          : '$0.00',
      }))
    );

    // 4. Product inventory analysis using window functions
    console.log('\n4. Product inventory analysis with rankings:');
    const inventoryAnalysis = await db.execute(sql`
      SELECT
        name,
        category,
        price,
        attributes['brand'] as brand,
        (SELECT SUM(value) FROM (SELECT unnest(map_values(inventory)) as value)) as total_inventory,
        RANK() OVER (PARTITION BY category ORDER BY price DESC) as price_rank_in_category
      FROM products
      WHERE is_active = true
      ORDER BY category, price_rank_in_category
    `);

    console.table(inventoryAnalysis);

    // 5. Event funnel analysis
    console.log('\n5. User journey funnel analysis:');
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

    console.table(funnelAnalysis);

    // 6. Revenue by shipping city with STRUCT field access
    console.log('\n6. Revenue by shipping city:');
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

    console.table(revenueByCity);

    // 7. Demonstrate loading data from a Parquet file (simulated)
    console.log('\n7. Creating and querying a Parquet file:');

    // Export to a Parquet file in the OS temp directory, then read it back
    const parquetPath = join(tmpdir(), 'orders_export.parquet');
    await db.execute(sql`
      COPY (
        SELECT
          u.name as customer_name,
          o.total_amount,
          o.status,
          o.ordered_at
        FROM orders o
        JOIN users u ON o.user_id = u.id
      ) TO ${parquetPath} (FORMAT PARQUET)
    `);

    // Query the parquet file directly
    const parquetData = await db.execute(sql`
      SELECT * FROM read_parquet(${parquetPath})
      ORDER BY total_amount DESC
    `);

    console.log('Data read directly from Parquet file:');
    console.table(parquetData);

    // 8. JSON field analysis
    console.log('\n8. User preferences analysis from JSON metadata:');
    const preferencesAnalysis = await db.execute(sql`
      SELECT
        metadata->>'signupSource' as signup_source,
        COUNT(*) as user_count,
        COUNT(CASE WHEN metadata->'preferences'->>'theme' = 'dark' THEN 1 END) as dark_theme_users,
        COUNT(CASE WHEN (metadata->'preferences'->>'notifications')::boolean = true THEN 1 END) as notifications_enabled
      FROM users
      GROUP BY metadata->>'signupSource'
    `);

    console.table(preferencesAnalysis);

    // 9. Time-based analysis with DuckDB date functions
    console.log('\n9. Events by hour of day:');
    const eventsByHour = await db.execute(sql`
      SELECT
        date_part('hour', timestamp) as hour_of_day,
        event_type,
        COUNT(*) as event_count
      FROM events
      GROUP BY date_part('hour', timestamp), event_type
      ORDER BY hour_of_day, event_count DESC
    `);

    console.table(eventsByHour);

    // 10. Complex join with all tables
    console.log('\n10. Complete customer order journey:');
    const customerJourney = await db.execute(sql`
      SELECT
        u.name as customer,
        u.tags as customer_tags,
        o.status as order_status,
        o.total_amount,
        o.shipping_address['city'] as ship_to_city,
        (
          SELECT COUNT(*)
          FROM events e
          WHERE e.user_id = u.id
          AND e.event_type = 'page_view'
        ) as page_views_before_order
      FROM users u
      JOIN orders o ON u.id = o.user_id
      ORDER BY o.ordered_at
    `);

    console.table(customerJourney);

    console.log('\n' + '='.repeat(60));
    console.log('Example completed successfully!');
    console.log('='.repeat(60));
  } finally {
    connection?.closeSync();
  }
}

main().catch(console.error);

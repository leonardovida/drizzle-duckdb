---
layout: default
title: Schema Definition
parent: Core Concepts
nav_order: 2
---

# Schema Definition

Define your database schema using Drizzle's type-safe schema builders.

## Basic Table

```typescript
import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});
```

## Column Types

### Standard Types (from pg-core)

```typescript
import {
  integer,
  bigint,
  smallint,
  real,
  doublePrecision,
  numeric,
  text,
  varchar,
  char,
  boolean,
  timestamp,
  date,
  time,
  uuid,
} from 'drizzle-orm/pg-core';
```

### DuckDB-Specific Types

```typescript
import {
  duckDbList,
  duckDbArray,
  duckDbStruct,
  duckDbMap,
  duckDbJson,
  duckDbTimestamp,
  duckDbDate,
  duckDbTime,
  duckDbBlob,
  duckDbInet,
  duckDbInterval,
} from '@duckdbfan/drizzle-duckdb';
```

See [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}) for detailed usage.

## Constraints

### Primary Key

```typescript
const users = pgTable('users', {
  id: integer('id').primaryKey(),
});

// Composite primary key
const orderItems = pgTable(
  'order_items',
  {
    orderId: integer('order_id'),
    productId: integer('product_id'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orderId, t.productId] }),
  })
);
```

### Not Null

```typescript
const users = pgTable('users', {
  name: text('name').notNull(),
});
```

### Unique

```typescript
const users = pgTable('users', {
  email: text('email').unique(),
});

// Named unique constraint
const users = pgTable(
  'users',
  {
    email: text('email'),
  },
  (t) => ({
    emailUnique: unique('users_email_unique').on(t.email),
  })
);
```

### Default Values

```typescript
const users = pgTable('users', {
  active: boolean('active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  data: text('data').default('empty'),
});
```

### Foreign Keys

```typescript
const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
});

// With explicit constraint
const posts = pgTable(
  'posts',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id'),
  },
  (t) => ({
    userFk: foreignKey({
      columns: [t.userId],
      foreignColumns: [users.id],
      name: 'posts_user_fk',
    }),
  })
);
```

## Relations

Define relations for relational queries:

```typescript
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name'),
});

export const posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id'),
  title: text('title'),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.userId],
    references: [users.id],
  }),
}));
```

Now you can use relational queries:

```typescript
const db = drizzle(connection, { schema });

const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: true,
  },
});
// [{ id: 1, name: 'Alice', posts: [{ id: 1, userId: 1, title: '...' }] }, ...]

const firstPost = await db.query.posts.findFirst({
  with: { author: true },
});
// { id: 1, userId: 1, title: '...', author: { id: 1, name: 'Alice' } }
```

`findMany()` returns an array and `findFirst()` returns one object or `undefined`. Result keys use the property names from your schema, such as `userId`, not the column names. Nested `with:` relations work. The driver rewrites Drizzle's Postgres JSON functions to DuckDB's `json_array` and `to_json(list(...))` for them.

## Schema Organization

### Single File (Small Projects)

```typescript
// schema.ts
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', { ... });
export const posts = pgTable('posts', { ... });

export const usersRelations = relations(users, ...);
export const postsRelations = relations(posts, ...);
```

### Multiple Files (Larger Projects)

```typescript
// schema/users.ts
export const users = pgTable('users', { ... });
export const usersRelations = relations(users, ...);

// schema/posts.ts
export const posts = pgTable('posts', { ... });
export const postsRelations = relations(posts, ...);

// schema/index.ts
export * from './users';
export * from './posts';
```

## Column Name Casing

Pass Drizzle's `casing` option to derive column names from the TypeScript keys, so you can leave out the name argument:

```typescript
const users = pgTable('users', {
  id: integer().primaryKey(),
  userName: text(),
});

const db = drizzle(connection, { casing: 'snake_case', schema: { users } });
await db.insert(users).values({ id: 1, userName: 'ada' });
// insert into "users" ("id", "user_name") values ($1, $2)
```

`casing` accepts `'snake_case'` and `'camelCase'`. Result keys still use the TypeScript names, such as `userName`.

## Custom Schemas

DuckDB's default schema is `main` (not `public` like Postgres):

```typescript
import { pgSchema } from 'drizzle-orm/pg-core';

const analyticsSchema = pgSchema('analytics');

export const events = analyticsSchema.table('events', {
  id: integer('id').primaryKey(),
  type: text('type'),
});
```

## Example: Complete Schema

```typescript
import {
  pgTable,
  integer,
  text,
  doublePrecision,
  boolean,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import {
  duckDbJson,
  duckDbList,
  duckDbStruct,
  duckDbTimestamp,
} from '@duckdbfan/drizzle-duckdb';

// Users table
export const users = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  preferences: duckDbJson<{
    theme: 'light' | 'dark';
    notifications: boolean;
  }>('preferences'),
  tags: duckDbList<string>('tags', 'TEXT'),
  createdAt: duckDbTimestamp('created_at', { withTimezone: true }),
});

// Products table
export const products = pgTable('products', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  price: doublePrecision('price').notNull(),
  attributes: duckDbStruct<{
    brand: string;
    category: string;
  }>('attributes', {
    brand: 'TEXT',
    category: 'TEXT',
  }),
  active: boolean('active').default(true),
});

// Orders table
export const orders = pgTable('orders', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  total: doublePrecision('total').notNull(),
  status: text('status').notNull(),
  orderedAt: duckDbTimestamp('ordered_at', { withTimezone: true }),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  user: one(users, {
    fields: [orders.userId],
    references: [users.id],
  }),
}));
```

## See Also

- [DuckDB Types]({{ '/features/duckdb-types' | relative_url }}): duckDB-specific types
- [Column Types]({{ '/api/columns' | relative_url }}): complete column reference
- [Queries]({{ '/core/queries' | relative_url }}): using your schema

---
layout: default
title: Array Helpers
parent: API Reference
nav_order: 4
---

# Array Helpers

DuckDB uses different functions than Postgres for array operations. These helpers cover common array queries.

## Overview

| Helper                 | Postgres Equivalent | DuckDB Function                 |
| ---------------------- | ------------------- | ------------------------------- |
| `duckDbArrayContains`  | `@>`                | `array_has_all(column, values)` |
| `duckDbArrayContained` | `<@`                | `array_has_all(values, column)` |
| `duckDbArrayOverlaps`  | `&&`                | `array_has_any(column, values)` |

JavaScript arrays passed as `values` are inlined as a `list_value(...)` literal. Pass a `SQLWrapper` to use a column, subquery or bound parameter instead.

The same helpers are also exported under DuckDB function names:

| Alias              | Same as                |
| ------------------ | ---------------------- |
| `arrayHasAll`      | `duckDbArrayContains`  |
| `arrayHasAny`      | `duckDbArrayOverlaps`  |
| `arrayContainedBy` | `duckDbArrayContained` |

## duckDbArrayContains

Check if an array contains **all** specified values.

### Signature

```typescript
function duckDbArrayContains<T>(
  column: SQLWrapper,
  values: T[] | SQLWrapper
): SQL;
```

### Usage

```typescript
import { duckDbArrayContains } from '@duckdbfan/drizzle-duckdb';

const products = pgTable('products', {
  id: integer('id').primaryKey(),
  tags: duckDbList<string>('tags', 'TEXT'),
});

// Find products that have BOTH 'electronics' AND 'sale' tags
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayContains(products.tags, ['electronics', 'sale']));
```

### Generated SQL

```sql
select ... from "products"
where array_has_all("products"."tags", list_value('electronics', 'sale'))
```

## duckDbArrayContained

Check if an array is **contained by** the specified values (all elements of the column are in the provided array).

### Signature

```typescript
function duckDbArrayContained<T>(
  column: SQLWrapper,
  values: T[] | SQLWrapper
): SQL;
```

### Usage

```typescript
import { duckDbArrayContained } from '@duckdbfan/drizzle-duckdb';

// Find products whose tags are ALL within the allowed set
const allowedTags = ['electronics', 'sale', 'featured', 'new'];

const results = await db
  .select()
  .from(products)
  .where(duckDbArrayContained(products.tags, allowedTags));
```

### Generated SQL

```sql
select ... from "products"
where array_has_all(list_value('electronics', 'sale', 'featured', 'new'), "products"."tags")
```

## duckDbArrayOverlaps

Check if arrays have **any** common elements.

### Signature

```typescript
function duckDbArrayOverlaps<T>(
  column: SQLWrapper,
  values: T[] | SQLWrapper
): SQL;
```

### Usage

```typescript
import { duckDbArrayOverlaps } from '@duckdbfan/drizzle-duckdb';

// Find products with at least ONE of these tags
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayOverlaps(products.tags, ['electronics', 'books']));
```

### Generated SQL

```sql
select ... from "products"
where array_has_any("products"."tags", list_value('electronics', 'books'))
```

## Using with SQLWrapper

All helpers accept `SQLWrapper` for dynamic queries:

```typescript
import { sql } from 'drizzle-orm';

// Compare two columns
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayOverlaps(products.tags, products.relatedTags));

// Use a subquery
const popularTags = sql`(SELECT array_agg(tag) FROM popular_tags)`;
const results = await db
  .select()
  .from(products)
  .where(duckDbArrayOverlaps(products.tags, popularTags));
```

## Postgres Array Operators

DuckDB supports `@>`, `<@` and `&&` on `LIST` and fixed-size `ARRAY` values with the same results as `array_has_all` and `array_has_any`, so Drizzle's Postgres helpers work without any rewrite:

```typescript
import { arrayContains, arrayOverlaps } from 'drizzle-orm';

// Runs as: WHERE "products"."tags" @> $1
const results = await db
  .select()
  .from(products)
  .where(arrayContains(products.tags, ['sale']));
```

{: .highlight }

> **Recommendation**
>
> Use the explicit `duckDbArray*` helpers when you want the generated SQL to show the DuckDB function names. They inline JavaScript arrays as `list_value(...)` literals, while Drizzle's helpers bind the array as a parameter.

## Complete Example

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import {
  drizzle,
  duckDbList,
  duckDbArrayContains,
  duckDbArrayOverlaps,
} from '@duckdbfan/drizzle-duckdb';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';

const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  tags: duckDbList<string>('tags', 'TEXT'),
  permissions: duckDbList<string>('permissions', 'TEXT'),
});

async function main() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const db = drizzle(connection);

  // Find premium users who are also newsletter subscribers
  const premiumNewsletter = await db
    .select()
    .from(users)
    .where(duckDbArrayContains(users.tags, ['premium', 'newsletter']));

  // Find users with any admin-related permission
  const adminUsers = await db
    .select()
    .from(users)
    .where(
      duckDbArrayOverlaps(users.permissions, [
        'admin',
        'super-admin',
        'moderator',
      ])
    );

  // Combine conditions
  const premiumAdmins = await db
    .select()
    .from(users)
    .where(
      and(
        duckDbArrayContains(users.tags, ['premium']),
        duckDbArrayOverlaps(users.permissions, ['admin', 'super-admin'])
      )
    );
}
```

## See Also

- [Array Operations]({{ '/core/arrays' | relative_url }}): guide to array handling
- [Column Types]({{ '/api/columns' | relative_url }}): `duckDbList` and `duckDbArray` types
- [Limitations]({{ '/reference/limitations' | relative_url }}): array operator differences

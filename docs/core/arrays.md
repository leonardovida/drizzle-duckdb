---
layout: default
title: Array Operations
parent: Core Concepts
nav_order: 5
---

# Array Operations

Learn how to work with array columns in DuckDB, including the differences from Postgres.

## Array Types

DuckDB has two array-like types:

### LIST (Variable Length)

```typescript
import { duckDbList } from '@duckdbfan/drizzle-duckdb';

const users = pgTable('users', {
  tags: duckDbList<string>('tags', 'TEXT'),
  scores: duckDbList<number>('scores', 'INTEGER'),
});
```

### ARRAY (Fixed Length)

```typescript
import { duckDbArray } from '@duckdbfan/drizzle-duckdb';

const users = pgTable('users', {
  rgb: duckDbArray<number>('rgb', 'INTEGER', 3),
  coordinates: duckDbArray<number>('coordinates', 'DOUBLE', 2),
});
```

## Inserting Array Data

```typescript
await db.insert(users).values({
  tags: ['typescript', 'drizzle', 'duckdb'],
  scores: [85, 92, 78],
});
```

Arrays are returned as native JavaScript arrays:

```typescript
const [user] = await db.select().from(users);
console.log(user.tags); // ['typescript', 'drizzle', 'duckdb']
```

## Querying Arrays

### Using DuckDB Helpers (Recommended)

```typescript
import {
  duckDbArrayContains,
  duckDbArrayContained,
  duckDbArrayOverlaps,
} from '@duckdbfan/drizzle-duckdb';
```

#### duckDbArrayContains

Check if array contains **all** specified values:

```typescript
// Find users with BOTH 'admin' AND 'verified' tags
const admins = await db
  .select()
  .from(users)
  .where(duckDbArrayContains(users.tags, ['admin', 'verified']));
```

Generated SQL:

```sql
SELECT * FROM users WHERE array_has_all(tags, ['admin', 'verified'])
```

#### duckDbArrayContained

Check if array is **contained by** the specified values:

```typescript
// Find users whose tags are ALL within ['basic', 'standard', 'premium']
const regularUsers = await db
  .select()
  .from(users)
  .where(duckDbArrayContained(users.tags, ['basic', 'standard', 'premium']));
```

Generated SQL:

```sql
SELECT * FROM users WHERE array_has_all(['basic', 'standard', 'premium'], tags)
```

#### duckDbArrayOverlaps

Check if arrays have **any** common elements:

```typescript
// Find users with ANY of these tags
const specialUsers = await db
  .select()
  .from(users)
  .where(
    duckDbArrayOverlaps(users.tags, ['vip', 'beta-tester', 'early-adopter'])
  );
```

Generated SQL:

```sql
SELECT * FROM users WHERE array_has_any(tags, ['vip', 'beta-tester', 'early-adopter'])
```

## Automatic Operator Rewriting

Drizzle DuckDB automatically rewrites Postgres array operators using AST transformation:

| Postgres | DuckDB Equivalent               |
| -------- | ------------------------------- |
| `@>`     | `array_has_all(column, values)` |
| `<@`     | `array_has_all(values, column)` |
| `&&`     | `array_has_any(column, values)` |

Postgres first-dimension bounds helpers are also rewritten for DuckDB lists:

| Postgres Function   | DuckDB Equivalent                                   |
| ------------------- | --------------------------------------------------- |
| `array_lower(a, 1)` | `CASE WHEN array_length(a) > 0 THEN 1 ELSE NULL END` |
| `array_upper(a, 1)` | `CASE WHEN array_length(a) > 0 THEN array_length(a) ELSE NULL END` |

This means Postgres-style code works seamlessly:

```typescript
import { arrayContains } from 'drizzle-orm/pg-core';

// This is automatically rewritten to DuckDB syntax
const results = await db
  .select()
  .from(users)
  .where(arrayContains(users.tags, ['admin']));
```

## Combining Array Conditions

```typescript
import { and, or } from 'drizzle-orm';

// Users with premium tag AND (vip OR early-adopter)
const premiumUsers = await db
  .select()
  .from(users)
  .where(
    and(
      duckDbArrayContains(users.tags, ['premium']),
      duckDbArrayOverlaps(users.tags, ['vip', 'early-adopter'])
    )
  );

// Users with admin permissions OR moderator permissions
const privilegedUsers = await db
  .select()
  .from(users)
  .where(
    or(
      duckDbArrayOverlaps(users.permissions, ['admin', 'super-admin']),
      duckDbArrayContains(users.permissions, ['moderator'])
    )
  );
```

## Array Functions in Raw SQL

DuckDB has many array functions available via raw SQL:

```typescript
import { sql } from 'drizzle-orm';

// Array length
const result = await db.execute(sql`
  SELECT name, array_length(tags) as tag_count
  FROM users
  WHERE array_length(tags) > 3
`);

// Array element access (1-indexed)
const result = await db.execute(sql`
  SELECT name, tags[1] as first_tag
  FROM users
`);

// Array aggregation
const result = await db.execute(sql`
  SELECT user_id, array_agg(tag) as all_tags
  FROM user_tags
  GROUP BY user_id
`);

// Unnest arrays
const result = await db.execute(sql`
  SELECT name, unnest(tags) as tag
  FROM users
`);

// Array concatenation
const result = await db.execute(sql`
  SELECT array_concat(tags, ['new-tag']) as updated_tags
  FROM users
`);
```

## Common Patterns

### Filter by Multiple Tags (AND)

```typescript
// Users who have ALL of these tags
const powerUsers = await db
  .select()
  .from(users)
  .where(duckDbArrayContains(users.tags, ['verified', 'premium', 'active']));
```

### Filter by Any Tag (OR)

```typescript
// Users who have ANY of these tags
const targetUsers = await db
  .select()
  .from(users)
  .where(duckDbArrayOverlaps(users.tags, ['marketing', 'sales', 'support']));
```

### Check Array Not Empty

```typescript
const usersWithTags = await db.execute(sql`
  SELECT * FROM users WHERE array_length(tags) > 0
`);
```

### Check Specific Element Exists

```typescript
const admins = await db.execute(sql`
  SELECT * FROM users WHERE list_contains(tags, 'admin')
`);
```

## Postgres Array Literal Warning

If you use Postgres-style array literals (`'{a,b,c}'`), you'll see a warning:

```typescript
// This triggers a warning
await db.execute(sql`SELECT * FROM users WHERE tags = '{a,b,c}'`);
// Warning: Postgres-style array literals are not supported
```

To make this a hard error:

```typescript
const db = drizzle(connection, {
  rejectStringArrayLiterals: true,
});
```

Use native JavaScript arrays instead:

```typescript
// Correct
await db.execute(sql`SELECT * FROM users WHERE tags = ['a', 'b', 'c']`);
```

## See Also

- [Array Helpers]({{ '/api/array-helpers' | relative_url }}) - API reference
- [Column Types]({{ '/api/columns' | relative_url }}) - LIST and ARRAY types
- [Limitations]({{ '/reference/limitations' | relative_url }}) - Array operator differences

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
select ... from "users" where array_has_all("users"."tags", list_value('admin', 'verified'))
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
select ... from "users" where array_has_all(list_value('basic', 'standard', 'premium'), "users"."tags")
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
select ... from "users" where array_has_any("users"."tags", list_value('vip', 'beta-tester', 'early-adopter'))
```

## Postgres Array Operators

DuckDB supports the Postgres array operators on `LIST` and fixed-size `ARRAY` columns, so the driver sends them unchanged:

| Postgres | Same result as                  |
| -------- | ------------------------------- |
| `@>`     | `array_has_all(column, values)` |
| `<@`     | `array_has_all(values, column)` |
| `&&`     | `array_has_any(column, values)` |

Postgres-style code keeps working:

```typescript
import { arrayContains } from 'drizzle-orm';

// Runs as: where "users"."tags" @> $1
const results = await db
  .select()
  .from(users)
  .where(arrayContains(users.tags, ['admin']));
```

Postgres first-dimension bounds helpers are rewritten for DuckDB lists:

| Postgres Function   | DuckDB Equivalent                                                  |
| ------------------- | ------------------------------------------------------------------ |
| `array_lower(a, 1)` | `CASE WHEN array_length(a) > 0 THEN 1 ELSE NULL END`               |
| `array_upper(a, 1)` | `CASE WHEN array_length(a) > 0 THEN array_length(a) ELSE NULL END` |

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

Strings bound to a column are never changed. Inserting `'{1,2}'` into a `text` column, or comparing a `text` column with `eq(t.note, '{1,2}')`, stores and compares the string as written.

Parameters without column information are checked for Postgres-style array literals. That covers values in plain `sql` templates, `sql.param(...)` values and bare `sql.placeholder(...)` values. Text written directly into the SQL string is not checked:

```typescript
// Checked: a plain sql template parameter
await db.execute(sql`SELECT * FROM users WHERE scores = ${'{1,2}'}`);
```

When such a parameter starts with `{` and ends with `}`, the driver converts it to a list if its contents parse as a JSON array after the braces become brackets. `'{1,2}'` becomes `[1, 2]` and `'{"a","b"}'` becomes `['a', 'b']`. A string such as `'{a,b,c}'` does not parse and stays a string.

In both cases the driver sends a warning through the configured logger, once per session. Pass `arrayLiteralWarning` to receive it in your own callback instead. The logged message is:

```
[duckdb] Received a stringified Postgres-style array literal. Use duckDbList()/duckDbArray() or pass native arrays instead. You can also set rejectStringArrayLiterals=true to throw.
```

To make this a hard error:

```typescript
const db = drizzle(connection, {
  rejectStringArrayLiterals: true,
});
```

With `rejectStringArrayLiterals: true` the query throws `Stringified array literals are not supported. Use duckDbList()/duckDbArray() or pass native arrays.`

Use native JavaScript arrays instead:

```typescript
// DuckDB list literal in SQL
await db.execute(sql`SELECT * FROM users WHERE tags = ['a', 'b', 'c']`);

// Or bind a JavaScript array as one parameter
await db.execute(
  sql`SELECT * FROM users WHERE tags = ${sql.param(['a', 'b', 'c'])}`
);
```

## See Also

- [Array Helpers]({{ '/api/array-helpers' | relative_url }}): API reference
- [Column Types]({{ '/api/columns' | relative_url }}): LIST and ARRAY types
- [Limitations]({{ '/reference/limitations' | relative_url }}): array operator differences

---
layout: default
title: Parquet Analytics
parent: Examples
nav_order: 5
---

# Query Parquet without importing tables

Use DuckDB to query a collection of Parquet exports and Drizzle to compose
filters and grouped measures, including joins to database lookup tables. The
sales stay in Parquet, with no sales import or migration needed.

Run the self-contained local example:

```bash
bun install --frozen-lockfile
bun example/parquet-analytics.ts
```

The example writes temporary Parquet fixtures, queries them, then closes its
connection and removes the files. It requires no MotherDuck account or network
access after dependencies are installed.

**Source**: [example/parquet-analytics.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/parquet-analytics.ts)

## Compose a file scan

`motherDuckReadParquet()` also works with local DuckDB when `mdRun` is omitted.
It binds paths and named option values as parameters. Pass a path, glob, or a
list of file paths. Do not interpolate paths into `sql.raw()`.

```typescript
import { motherDuckReadParquet } from '@duckdbfan/drizzle-duckdb';

const source = motherDuckReadParquet(
  ['exports/first.parquet', 'exports/second.parquet'],
  {
    named: { union_by_name: true, hive_partitioning: true },
  }
);
```

Use explicit selections with `db.select({...}).from(source)`. Alias that query
with `.as('sales')` to reuse its fields in filters, grouping, and ordering.
The runnable example demonstrates the complete composition.

## Join files to a dimension table

The runnable example creates a small `regions` lookup table and joins its
labels to the file-backed `sales` selection before grouping:

```typescript
import { eq, isNotNull } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { countN, sumN } from '@duckdbfan/drizzle-duckdb';

const regions = pgTable('regions', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
});

const report = await db
  .select({
    region: sales.region,
    label: regions.label,
    orders: countN(),
    revenue: sumN(sales.amount),
  })
  .from(sales)
  .leftJoin(regions, eq(sales.region, regions.code))
  .where(isNotNull(sales.amount))
  .groupBy(sales.region, regions.label)
  .orderBy(sales.region);
```

The `pgTable` declaration describes an existing table. Create it separately,
as the runnable demo does, or use your application's migrated lookup table.
Its primary key prevents multiple dimension rows from multiplying each sale.

The report keeps the original region code and uses a left join so an unknown
code retains its sales with a `null` label, inferred as `string | null`.
Grouping by both code and label keeps unknown regions separate. Lookup rows
without sales do not appear. Filtering the right-hand label in `where` would
remove unmatched sales, so choose that policy deliberately.

Expected demo output:

| region | label          | orders | revenue |
| ------ | -------------- | ------ | ------- |
| east   | null           | 1      | 7       |
| west   | Western region | 2      | 15      |

East has no lookup entry, while the unused north lookup entry is absent. The
west export without an amount is still excluded before aggregation.

## Diagnose changing export schemas

If a report fails after an export changes, inspect the same file set and scan
options before changing its TypeScript selection:

```typescript
import { sql } from 'drizzle-orm';

const columns = await db.execute(sql`DESCRIBE SELECT * FROM ${source}`);
console.table(columns);
```

`DESCRIBE` reports column names and DuckDB types. It does not validate every
value. If `amount` is absent from every file, `union_by_name` cannot create it
and the report fails during binding. Restore the column in the export or choose
the correct file set. Do not replace an unknown amount with zero by default.

An export containing text amounts such as `'10.50'` has a `VARCHAR` column.
The report's `SUM` rejects it even though the selection uses `sql<number>` and
`.mapWith(Number)`: those declarations do not cast values before aggregation.
When numeric text is the intended input contract, cast explicitly in SQL:

```typescript
import { sumN } from '@duckdbfan/drizzle-duckdb';

const totals = await db
  .select({ revenue: sumN(sql`CAST(amount AS DECIMAL(18, 2))`) })
  .from(source);
```

Choose precision and scale for your data. This example returns 15 for text
amounts `'10.50'` and `'4.50'`, and rejects `'invalid'`. `TRY_CAST` would turn
invalid values into NULL, which `SUM` ignores, so use it only with an explicit
rejection-count or quarantine policy. `sumN` still converts the final total to
a JavaScript number. Use an exact result representation when required.

## Schema and value boundaries

- `union_by_name` matches columns by name across files and fills missing columns
  with SQL NULL. The example excludes rows with a missing amount before
  aggregating. Choose a missing-data policy appropriate for your own reports.
- `hive_partitioning` reads partition values from directories such as
  `region=west/`. Keep partition names and types consistent across files.
- TypeScript selections describe the schema you expect. They do not inspect
  Parquet files or validate their runtime contents. Missing columns across all
  files or incompatible types can still produce DuckDB errors.
- `sumN()` and `countN()` convert results to JavaScript numbers. Use an exact
  decimal or bigint representation instead when precision matters.
- Local paths are resolved on the machine running DuckDB. Remote storage needs
  the relevant DuckDB extension and credentials. This example tests local files
  only and does not configure or verify remote access.

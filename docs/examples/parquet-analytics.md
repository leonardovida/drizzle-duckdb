---
layout: default
title: Parquet Analytics
parent: Examples
nav_order: 5
---

# Query Parquet without importing tables

Use DuckDB to query a collection of Parquet exports and Drizzle to compose
filters and grouped measures. No database schema migration or data import is
needed for this workflow.

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

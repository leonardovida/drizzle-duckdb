---
layout: default
title: DuckLake
parent: Integrations
nav_order: 4
---

# DuckLake

DuckLake stores DuckDB tables on object storage while keeping metadata in a catalog. Drizzle DuckDB can attach a DuckLake catalog during connection setup.

## Local DuckLake Catalog

Create a DuckLake catalog backed by a local DuckDB file and point data to a directory:

```typescript
import { drizzle } from '@duckdbfan/drizzle-duckdb';

const db = await drizzle(':memory:', {
  ducklake: {
    catalog: './ducklake.duckdb',
    attachOptions: {
      dataPath: './ducklake-data',
      createIfNotExists: true,
    },
  },
});
```

## MotherDuck DuckLake

Create a DuckLake database in MotherDuck, then attach its metadata catalog:

```sql
CREATE DATABASE my_lake TYPE DUCKLAKE;
```

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@duckdbfan/drizzle-duckdb';

const db = await drizzle({
  connection: {
    path: 'md:',
    options: { motherduck_token: process.env.MOTHERDUCK_TOKEN },
  },
  ducklake: {
    catalog: 'md:__ducklake_metadata_my_lake',
  },
});
```

## Pooling Guidance

A DuckLake catalog stored in a local DuckDB file supports one DuckDB process at a time. When the catalog is local and you do not set `pool`, `drizzle()` uses a pool of size 1.

A catalog counts as local when it is `:memory:`, ends in `.duckdb`, `.ddb` or `.ducklake`, or looks like a file path. `md:` catalogs, URLs and Postgres, MySQL or SQLite connection strings do not.

You can set a larger `pool`. All pooled connections share one DuckDB instance and one attached catalog. The driver runs the attach with `ATTACH IF NOT EXISTS` and sets up one connection at a time, so extra connections reuse the catalog. With a local catalog and a pool size above 1, `drizzle()` logs a `[ducklake]` warning about write conflicts.

The driver generates SQL of this form, with each attach option written as `NAME value`:

```sql
ATTACH IF NOT EXISTS 'ducklake:./ducklake.duckdb' AS "ducklake" (CREATE_IF_NOT_EXISTS true, DATA_PATH './ducklake-data');
USE "ducklake";
```

## Manual Setup

If you have a direct connection, call `configureDuckLake` before using Drizzle:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { configureDuckLake, drizzle } from '@duckdbfan/drizzle-duckdb';

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();

await configureDuckLake(connection, {
  catalog: './ducklake.duckdb',
  attachOptions: { dataPath: './ducklake-data' },
});

const db = drizzle(connection);
```

## Limitations

DuckLake only supports `NOT NULL` constraints. Primary keys, foreign keys, unique constraints, and indexes are not supported. Avoid relying on those features in migrations or schema design.

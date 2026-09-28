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

A catalog counts as local when it is `:memory:`, starts with `duckdb:` or `file:`, or has no scheme and looks like a file path, such as `meta.db` or `./lake/meta`. Catalogs with another scheme, such as `md:`, `s3:`, `postgres:` or `sqlite:`, do not. A bare name such as `my_lake` does not either, because DuckLake reads it as a secret name.

You can set a larger `pool`. All pooled connections share one DuckDB instance and one attached catalog. The driver runs the attach with `ATTACH IF NOT EXISTS` and sets up one connection at a time, so extra connections reuse the catalog. With a local catalog and a pool size above 1, `drizzle()` logs a `[ducklake]` warning about write conflicts.

The driver generates SQL of this form, with each attach option written as `NAME value`:

```sql
ATTACH IF NOT EXISTS 'ducklake:./ducklake.duckdb' AS "ducklake" (CREATE_IF_NOT_EXISTS true, DATA_PATH './ducklake-data');
USE "ducklake";
```

`ATTACH IF NOT EXISTS` does nothing when the alias already names a database. After the attach, the driver checks `duckdb_databases()` and throws if the alias is not a DuckLake database, or if a local catalog under that alias is a different file. This happens when the main database file is named `ducklake.duckdb`, or when two configs with different catalogs share one pool and keep the default alias. Set `alias` to a different name in those cases. Secret, MotherDuck and other remote catalogs only get the type check, because DuckDB reports their resolved metadata path.

## Attach Options

`attachOptions` maps to DuckLake `ATTACH` options: `createIfNotExists`, `dataInliningRowLimit`, `dataPath`, `encrypted`, `metadataCatalog`, `overrideDataPath` and `readOnly`. `dataInliningRowLimit` must be a non-negative integer. Other numbers, such as `NaN` or `Infinity`, throw.

Use `metaParameters` to pass options to the metadata catalog. Each key becomes `META_<KEY>`, and keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`:

```typescript
const db = await drizzle(':memory:', {
  ducklake: {
    catalog: './meta.ducklake',
    attachOptions: {
      dataPath: './ducklake-data',
      metaParameters: { type: 'duckdb' },
    },
  },
});
// ATTACH IF NOT EXISTS 'ducklake:./meta.ducklake' AS "ducklake" (DATA_PATH './ducklake-data', META_TYPE 'duckdb')
```

`metaParameterName` is deprecated. It emitted `META_PARAMETER_NAME`, which DuckLake always rejected, so setting it now throws. Use `metaParameters` instead.

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

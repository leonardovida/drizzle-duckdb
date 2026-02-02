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
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

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
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

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

DuckLake catalogs stored in a DuckDB file are single client only. When a local catalog is detected, `drizzle()` defaults to a single connection pool size of 1. You can override this with `pool`, but it can cause write conflicts.

## Manual Setup

If you have a direct connection, call `configureDuckLake` before using Drizzle:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import {
  configureDuckLake,
  drizzle,
} from '@leonardovida-md/drizzle-neo-duckdb';

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

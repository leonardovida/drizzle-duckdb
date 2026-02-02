---
layout: default
title: DuckLake Local Catalog
parent: Examples
nav_order: 3
---

# DuckLake Local Catalog Example

This example attaches a local DuckLake catalog backed by a DuckDB file and writes a small table.

**Source**: [example/ducklake-local.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/ducklake-local.ts)

## Run the Example

```bash
bun run example/ducklake-local.ts
```

## What It Demonstrates

- DuckLake catalog attach via the `ducklake` config
- Data path configuration for DuckLake tables
- Basic insert and select workflow

## Key Snippet

```typescript
const db = await drizzle(':memory:', {
  ducklake: {
    catalog: './ducklake.duckdb',
    install: true,
    load: true,
    attachOptions: {
      dataPath: './ducklake-data',
      createIfNotExists: true,
    },
  },
});
```

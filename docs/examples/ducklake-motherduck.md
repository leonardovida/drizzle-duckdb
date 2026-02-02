---
layout: default
title: DuckLake MotherDuck
parent: Examples
nav_order: 4
---

# DuckLake MotherDuck Example

This example attaches a DuckLake catalog hosted on MotherDuck and writes a small table.

**Source**: [example/ducklake-motherduck.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/ducklake-motherduck.ts)

## Prerequisites

- A MotherDuck account and service token
- A DuckLake database created in MotherDuck, for example `CREATE DATABASE my_lake TYPE DUCKLAKE;`

## Run the Example

```bash
export MOTHERDUCK_TOKEN=your_token_here
export DUCKLAKE_MOTHERDUCK_DB=my_lake
bun run example/ducklake-motherduck.ts
```

## What It Demonstrates

- DuckLake catalog attach using MotherDuck metadata
- Basic insert and select workflow

## Key Snippet

```typescript
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

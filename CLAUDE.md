# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `@duckdbfan/drizzle-duckdb`, a DuckDB dialect adapter for drizzle-orm. It builds on Drizzle's Postgres driver surface but targets DuckDB, providing query building, migrations, and type inference for DuckDB's Node runtime (`@duckdb/node-api`). The legacy package name `@leonardovida-md/drizzle-neo-duckdb` remains published for backward compatibility.

## Commands

- **Install dependencies:** `bun install`
- **Run all tests:** `bun test`
- **Run tests with watch mode and UI:** `bun t`
- **Run a single test file:** `bun test test/<filename>.test.ts`
- **Build:** `bun run build` (emits `dist/index.mjs`, `dist/helpers.mjs`, `dist/duckdb-introspect.mjs`, and type declarations)
- **Build declarations only:** `bun run build:declarations`
- **Run benchmarks:** `bun bench` (runs perf benchmarks in `test/perf/`)
- **Run perf comparison:** `bun run perf:run` then `bun run perf:compare`

## Architecture

### Core Module Structure (`src/`)

The package exports from `src/index.ts` which re-exports:

- `driver.ts` - Main entry point with `drizzle()` factory and `DuckDBDatabase` class extending `PgDatabase`
- `session.ts` - `DuckDBSession` and `DuckDBPreparedQuery` for query execution, transaction handling
- `dialect.ts` - `DuckDBDialect` extending `PgDialect` with DuckDB-specific SQL generation
- `columns.ts` - DuckDB-specific column helpers (`duckDbList`, `duckDbArray`, `duckDbStruct`, `duckDbMap`, `duckDbJson`, `duckDbTimestamp`, etc.)
- `pool.ts` - Connection pooling with `createDuckDBConnectionPool()` for concurrent query execution
- `client.ts` - Low-level client utilities
- `operators.ts` - DuckDB array operators (`duckDbArrayContains`, `duckDbArrayContained`, `duckDbArrayOverlaps`)
- `olap.ts` - OLAP-specific helpers and streaming methods (`executeBatches()`, `executeArrow()`)
- `migrator.ts` - `migrate()` function for applying SQL migrations
- `introspect.ts` - Schema introspection for generating Drizzle schema from existing DuckDB tables
- `value-wrappers.ts` - Serialization of complex types to DuckDB literal syntax
- `helpers.ts` - Browser-safe column helpers (used by introspection output)

### SQL Transformation Pipeline (`src/sql/`)

- `ast-transformer.ts` - Main AST transformation entry point using `node-sql-parser`
- `visitors/array-operators.ts` - Rewrites Postgres array operators (`@>`, `<@`, `&&`) to DuckDB's `array_has_*` functions
- `visitors/column-qualifier.ts` - Handles column qualification for DuckDB compatibility
- `result-mapper.ts` - Converts DuckDB query results to Drizzle's expected format, including alias deduplication
- `selection.ts` - Selection/projection handling

### Key Design Decisions

1. **Built on Postgres Driver**: Extends `PgDialect`, `PgSession`, `PgDatabase` from `drizzle-orm/pg-core` since DuckDB's SQL is largely Postgres-compatible

2. **Array Operator Rewriting**: Postgres array operators are automatically rewritten to DuckDB's `array_has_*` functions via AST transformation

3. **Custom Column Types**: DuckDB-specific types (STRUCT, MAP, LIST, JSON) use custom type builders that handle serialization to DuckDB literal syntax

4. **Connection Pooling**: DuckDB executes one query per connection; the pool (default size 4) enables concurrent queries

5. **No Pg JSON/JSONB**: The dialect throws if Postgres JSON/JSONB columns are used - must use `duckDbJson()` instead

### Testing

Tests are in `test/` using Vitest. Test categories:

- `duckdb.test.ts` - Main integration tests
- `arrays.test.ts`, `columns.test.ts`, `json.test.ts` - Column type handling
- `pool.*.test.ts` - Connection pool behavior
- `introspect.*.test.ts` - Schema introspection
- `ast-transformer.*.test.ts` - SQL rewriting
- `motherduck.integration.test.ts` - MotherDuck cloud tests (requires `MOTHERDUCK_TOKEN`)
- `test/perf/*.bench.ts` - Performance benchmarks

### CLI Tool

`src/bin/duckdb-introspect.ts` provides a CLI for generating Drizzle schema from DuckDB:

```sh
bun x duckdb-introspect --url ':memory:' --schema my_schema --out ./drizzle/schema.ts
```

## Important Conventions

- ESM only with explicit `.ts` extensions in imports
- Source uses `moduleResolution: bundler`
- Never edit files in `dist/` - they are generated
- Never use emojis in comments or code
- Be concise and to the point

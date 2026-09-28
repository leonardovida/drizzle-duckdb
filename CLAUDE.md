# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is `@duckdbfan/drizzle-duckdb`, a DuckDB dialect adapter for drizzle-orm. It builds on Drizzle's Postgres driver surface but targets DuckDB, providing query building, migrations, and type inference for DuckDB's Node runtime (`@duckdb/node-api`).

## Commands

- **Install dependencies:** `bun install`
- **Run all tests:** `bun run test` (runs Vitest. Plain `bun test` starts Bun's own test runner instead)
- **Run tests with watch mode and UI:** `bun run t`
- **Run a single test file:** `bun run test test/<filename>.test.ts`
- **Build:** `bun run build` (emits `dist/index.mjs`, `dist/helpers.mjs`, `dist/duckdb-introspect.mjs`, and type declarations)
- **Build declarations only:** `bun run build:declarations`
- **Run benchmarks:** `bun run bench` (runs perf benchmarks in `test/perf/`)
- **Run perf comparison:** `bun run perf:run` then `bun run perf:compare`

## Architecture

### Core Module Structure (`src/`)

The package exports from `src/index.ts`, which re-exports most of these modules:

- `driver.ts`: `drizzle()` factory and the `DuckDBDatabase` class extending `PgDatabase`, including `executeBatches()`, `executeBatchesRaw()`, `executeArrow()` and `close()`
- `session.ts`: `DuckDBSession` and `DuckDBPreparedQuery` for query execution and transaction handling
- `dialect.ts`: `DuckDBDialect` extending `PgDialect` with DuckDB-specific SQL generation
- `select-builder.ts`: select builders that apply duplicate-column aliasing
- `columns.ts`: DuckDB column helpers (`duckDbList`, `duckDbArray`, `duckDbStruct`, `duckDbMap`, `duckDbJson`, `duckDbTimestamp`, etc.) and the array predicate helpers (`duckDbArrayContains`, `duckDbArrayContained`, `duckDbArrayOverlaps`)
- `operators.ts`: aliases for the array predicate helpers (`arrayHasAll`, `arrayHasAny`, `arrayContainedBy`)
- `pool.ts`: `createDuckDBConnectionPool()`, pool presets and pool size resolution
- `client.ts`: low-level execution against a connection or pool, parameter preparation and streaming
- `pgduck.ts`: pg_duckdb client and pool adapter
- `options.ts`: `prepareCache` option parsing
- `prepared-statement-cache.ts`: per-connection LRU cache of prepared statements
- `array-literals.ts`: detection and parsing of Postgres-style array literal strings
- `time.ts`: TIME and TIMESTAMP string helpers
- `olap.ts`: OLAP helpers (`sumN`, `percentileCont`, window helpers, the `olap()` builder, Lance search)
- `motherduck.ts`: MotherDuck table function helpers (Dives, Flights, access tokens, file scans)
- `jev.ts`: `mdPromptJev()` helper
- `ducklake.ts`: DuckLake attach SQL, `configureDuckLake()`, pool wrapping and local catalog detection
- `migrator.ts`: `migrate()` function for applying SQL migrations
- `migration-config.ts`: migration config normalization
- `introspect.ts`: schema introspection for generating a Drizzle schema from existing DuckDB tables
- `value-wrappers.ts`: conversion of wrapped values to DuckDB bindings and literals
- `value-wrappers-core.ts`: browser-safe value wrapper tags
- `own-property.ts`: assigns result keys such as `__proto__` as own properties
- `helpers.ts`: browser-safe column helpers (used by introspection output)

### SQL Transformation Pipeline (`src/sql/`)

- `ast-transformer.ts`: AST transformation entry point using `node-sql-parser`. It parses only when a pattern matches and keeps the original SQL when the reprint would change literals, parameters or identifiers
- `visitors/array-bounds.ts`: rewrites `array_lower(a, 1)` and `array_upper(a, 1)`, which DuckDB lacks
- `visitors/column-qualifier.ts`: qualifies unqualified column references in JOIN ON clauses
- `visitors/generate-series-alias.ts`: rewrites Postgres-style `generate_series` aliases
- `visitors/union-with-hoister.ts`: hoists WITH clauses out of UNION and other set operations
- `visitors/ast-helpers.ts`: shared AST predicates
- `result-mapper.ts`: converts DuckDB query results to Drizzle's expected format, including alias deduplication
- `selection.ts`: selection and projection handling
- `split-top-level.ts`: splits strings on top-level delimiters

### Key Design Decisions

1. **Built on Postgres Driver**: Extends `PgDialect`, `PgSession`, `PgDatabase` from `drizzle-orm/pg-core` since DuckDB's SQL is largely Postgres-compatible

2. **Array Operators Pass Through**: DuckDB supports `@>`, `<@` and `&&` on LIST and ARRAY natively, so the driver sends them unchanged. The `duckDbArray*` helpers emit `array_has_all` and `array_has_any`

3. **Custom Column Types**: DuckDB-specific types (STRUCT, MAP, LIST, JSON) use custom type builders that handle serialization to DuckDB literal syntax

4. **Connection Pooling**: DuckDB executes one query per connection. The pool (default size 4) enables concurrent queries

5. **No Pg JSON/JSONB**: Queries with Postgres JSON/JSONB columns throw. Use `duckDbJson()` instead

### Testing

Tests are in `test/` using Vitest. Test categories:

- `duckdb.test.ts`: Main integration tests
- `arrays.test.ts`, `columns.test.ts`, `json.test.ts`: Column type handling
- `pool.*.test.ts`: Connection pool behavior
- `introspect.*.test.ts`: Schema introspection
- `ast-transformer.*.test.ts`: SQL rewriting
- `motherduck.integration.test.ts`: MotherDuck cloud tests (requires `MOTHERDUCK_TOKEN`)
- `test/perf/*.bench.ts`: Performance benchmarks

### CLI Tool

`src/bin/duckdb-introspect.ts` (argument parsing in `src/bin/duckdb-introspect-args.ts`) provides a CLI for generating Drizzle schema from DuckDB:

```sh
bun x duckdb-introspect --url ':memory:' --schema my_schema --out ./drizzle/schema.ts
```

## Important Conventions

- ESM only with explicit `.ts` extensions in imports
- Source uses `moduleResolution: bundler`
- Never edit files in `dist/`. They are generated
- Never use emojis in comments or code
- Be concise and to the point

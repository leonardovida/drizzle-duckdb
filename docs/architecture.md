---
layout: default
title: Architecture
parent: Reference
nav_order: 6
---

# Architecture Map

A short map of the source tree for contributors.

## Entry Points and Runtime Modes

- `src/driver.ts`: `drizzle(...)` factory with five overloads. The connection-string and `{ connection }` forms get a shared `DuckDBInstance` for the path through `DuckDBInstance.fromCache()` and create either one connection (`pool: false`) or a pool from `createDuckDBConnectionPool()`. The client forms wrap an existing connection or pool, and wrap a raw `pg.Pool` with `createPgDuckConnectionPool()`. Passes `casing` to the dialect. Builds `DuckDBDatabase`, which adds `executeBatches`, `executeBatchesRaw`, `executeArrow`, `close()`, `$client` and `$instance`.
- `src/pool.ts`: connection pool that opens connections with `DuckDBConnection.create(instance)` and hands them out with `acquire()` and `release()`, an acquire timeout, a cap on waiting requests, and recycling via `maxLifetimeMs` and `idleTimeoutMs`. Idle connections are reused newest first. Waiting requests are served in arrival order. Also defines the MotherDuck size presets.
- `src/pgduck.ts`: adapter types and `createPgDuckConnectionPool()` for Postgres wire clients connected to pg_duckdb.

## Drizzle Integration Points

- `src/dialect.ts`: `DuckDBDialect` extends `PgDialect`. Overrides `prepareTyping()` and `migrate()`, rejects `PgJson` and `PgJsonb`, tracks savepoint support per instance, and runs every generated query through the AST transformer in `sqlToQuery()`. `migrate()` retries on write-write conflicts and uses a plain journal table when DuckLake is the current catalog.
- `src/migrator.ts`: `migrate()`, which queues calls on the same database file or client before calling the dialect.
- `src/instance-keys.ts`: records which database path each shared DuckDB instance points at, so `migrate()` can queue per database.
- `src/session.ts`: `DuckDBSession` extends `PgSession`. Pins one pooled connection per transaction, probes savepoint support for nested transactions, checks string parameters for Postgres array literals, keeps `numeric()` columns as exact DECIMAL strings, and wires streaming, columnar fetch and the prepared statement cache into `DuckDBPreparedQuery`.
- `src/select-builder.ts`: DuckDB select builder used by `db.select()`. Aliases duplicate column names and exposes subquery, CTE and view fields qualified by their alias.

## Client and Value Conversion

- `src/client.ts`: parameter preparation, value conversion to `@duckdb/node-api` values with explicit bind types, materialized execution with a per-column result converter, streaming (`executeInBatches`, `executeInBatchesRaw`) with a per-connection streaming marker, the columnar path behind `executeArrow`, column name deduplication, and connection cleanup that interrupts running queries.
- `src/prepared-statement-cache.ts`: optional per-connection LRU cache for prepared statements.
- `src/value-wrappers*.ts`: wrappers for list, array, struct, map, JSON, blob and timestamp values, and the list item type inference used for binding.

## DuckDB Types, Helpers, and Rewriting

- `src/columns.ts`: DuckDB column helpers (`duckDbList`, `duckDbArray`, `duckDbMap`, `duckDbStruct`, `duckDbJson`, `duckDbTimestamp` and others), literal builders, and the array predicate helpers. `src/operators.ts` re-exports those predicates as `arrayHasAll`, `arrayHasAny` and `arrayContainedBy`.
- `src/olap.ts`: numeric aggregates, window helpers, Lance search helpers and the `olap()` builder.
- `src/motherduck.ts` and `src/jev.ts`: MotherDuck table function helpers.
- `src/ducklake.ts`: DuckLake attach and pool setup.
- `src/sql/ast-transformer.ts`: AST-based SQL transformer using `node-sql-parser`. It parses only queries that match a rewrite pattern and keeps the original SQL when the printed result would drop string literals, parameters or quoted identifiers. Visitors in `src/sql/visitors/` rewrite `array_lower`/`array_upper` (`array-bounds.ts`), qualify ambiguous join columns (`column-qualifier.ts`), alias `generate_series` (`generate-series-alias.ts`) and hoist `WITH` clauses out of set operation arms (`union-with-hoister.ts`). Postgres array operators pass through unchanged.
- `src/sql/result-mapper.ts`: maps result rows into Drizzle's nested selection shape.

## Introspection and CLI

- `src/introspect.ts` and `src/bin/duckdb-introspect.ts`: read `information_schema` and `duckdb_*` tables to emit `schema.ts` plus JSON metadata. Generated columns are found in the `CREATE TABLE` text from `duckdb_tables()`. The CLI checks that the requested database and schemas exist before it writes. Argument parsing lives in `src/bin/duckdb-introspect-args.ts`.

## Examples and Perf Harness

- `example/`: runnable examples.
- `test/perf/`, `scripts/run-perf.ts`, `scripts/compare-perf.ts`: Vitest bench suites covering builder paths, streaming, columnar fetch, prepared reuse and pooled mode, plus scripts that record and compare results.

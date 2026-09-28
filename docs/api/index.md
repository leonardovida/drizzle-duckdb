---
layout: default
title: API Reference
nav_order: 7
has_children: true
permalink: /api/
---

# API Reference

Complete API documentation for Drizzle DuckDB.

## Main Exports

- [drizzle()]({{ '/api/drizzle' | relative_url }}): create a database instance
- [DuckDBDatabase]({{ '/api/database' | relative_url }}): database class methods
- [Column Types]({{ '/api/columns' | relative_url }}): all column type helpers
- [Array Helpers]({{ '/api/array-helpers' | relative_url }}): array query functions
- [OLAP Helpers]({{ '/api/olap-helpers' | relative_url }}): aggregate helpers and MotherDuck table functions
- [migrate()]({{ '/api/migrate' | relative_url }}): run migrations
- [introspect()]({{ '/api/introspect' | relative_url }}): generate schema from an existing database

## Other Exports

- `createDuckDBConnectionPool()`: build a pool by hand. See [Connection Pooling]({{ '/core/connection' | relative_url }}#connection-pooling)
- `createPgDuckConnectionPool()`: wrap a `pg.Pool` for pg_duckdb. `drizzle()` does this for you when you pass a `pg.Pool`
- `configureDuckLake()`: attach a DuckLake catalog on a single connection. See [DuckLake]({{ '/integrations/ducklake' | relative_url }}#manual-setup)
- `DuckDBDialect`: the dialect class. `new DuckDBDialect().sqlToQuery(query)` renders SQL the way the driver sends it, without a connection
- `DuckDBSelectBuilder`: the type that `db.select()` returns
- `DuckDbMigrationConfig`: the type of the `migrate()` config argument

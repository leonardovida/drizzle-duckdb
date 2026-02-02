---
layout: default
title: Examples
nav_order: 5
has_children: true
permalink: /examples/
---

# Examples

This section showcases complete, runnable examples demonstrating Drizzle DuckDB in real-world scenarios. All examples live in `/example` and run with Bun.

## Available Examples

### [Analytics Dashboard]({{ '/examples/analytics-dashboard' | relative_url }})

A comprehensive example showing:

- Multi-table schema with foreign keys
- DuckDB-specific types (STRUCT, LIST, MAP, JSON)
- Transactions for data integrity
- Complex aggregations and window functions
- Array operations with DuckDB helpers
- Loading and querying Parquet files

**Best for**: Learning DuckDB-specific features and analytical patterns.

Run locally (auto-pooling in-memory):

```bash
bun example/analytics-dashboard.ts
```

### [NYC Taxi (MotherDuck)]({{ '/examples/motherduck-nyc-taxi' | relative_url }})

Cloud database example featuring:

- MotherDuck connection and authentication
- Querying sample data (NYC taxi trips)
- Aggregations with GROUP BY
- CTEs for multi-step transformations
- Date/time operations
- Percentile calculations

**Best for**: Getting started with MotherDuck and cloud analytics.

Run with auto-pooling (default 4 connections):

```bash
export MOTHERDUCK_TOKEN=your_token_here
bun example/motherduck-nyc-taxi.ts
```

## Running Examples

All examples are located in the `/example` directory of the repository.

### Prerequisites

1. Clone the repository:

   ```bash
   git clone https://github.com/leonardovida/drizzle-duckdb.git
   cd drizzle-duckdb
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

### Local Examples

```bash
# Run the analytics dashboard example
bun run example/analytics-dashboard.ts
```

### MotherDuck Examples

```bash
# Set your MotherDuck token
export MOTHERDUCK_TOKEN=your_token_here

# Run the NYC taxi example
bun run example/motherduck-nyc-taxi.ts
```

## Example Structure

Each example follows a similar pattern:

```typescript
import { DuckDBInstance } from '@duckdb/node-api';
import { drizzle } from '@leonardovida-md/drizzle-neo-duckdb';

// 1. Define schema
const users = pgTable('users', { ... });

// 2. Create connection
const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
const db = drizzle(connection);

// 3. Run queries
const results = await db.select().from(users);

// 4. Clean up
connection.closeSync();
```

## Building Your Own

Use these examples as starting points for your own projects. Key patterns to follow:

1. **Schema Definition**: Define your tables with proper types
2. **Connection Management**: Use singleton patterns for persistent connections
3. **Query Patterns**: Leverage Drizzle's type-safe query builder
4. **Error Handling**: Wrap operations in try/finally for cleanup

## See Also

- [Getting Started]({{ '/getting-started/' | relative_url }}) - Basic setup guide
- [Core Concepts]({{ '/core/queries' | relative_url }}) - Query patterns
- [API Reference]({{ '/api/drizzle' | relative_url }}) - Complete API documentation

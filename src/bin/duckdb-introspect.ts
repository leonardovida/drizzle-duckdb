#!/usr/bin/env node
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { closeClientConnection, closeDuckDbInstance } from '../client.ts';
import { drizzle } from '../index.ts';
import { configureDuckLake } from '../ducklake.ts';
import { introspect } from '../introspect.ts';
import { CliUsageError, parseArgs } from './duckdb-introspect-args.ts';

function printHelp(): void {
  console.log(`duckdb-introspect

Usage:
  bun x duckdb-introspect --url <duckdb path|md:> [--schema my_schema] [--out ./drizzle/schema.ts]

Options:
  --url            DuckDB database path (e.g. :memory:, ./local.duckdb, md:)
  --database, --db Database/catalog to introspect (default: current database)
  --all-databases  Introspect all attached databases (not just current)
  --schema         Comma separated schema list (defaults to all non-system schemas)
  --out            Output file (default: ./drizzle/schema.ts)
  --json           Optional JSON metadata output file (e.g. ./drizzle/schema.meta.json)
  --include-views  Include views in the generated schema
  --use-pg-time    Use pg-core timestamp/date/time instead of DuckDB custom helpers
  --import-base    Override import path for duckdb helpers (default: @duckdbfan/drizzle-duckdb/helpers)
  --ducklake-catalog           DuckLake catalog value after the ducklake: prefix
  --ducklake-alias             Alias for attached DuckLake database
  --ducklake-no-use            Do not run USE after attach
  --ducklake-install           Run INSTALL ducklake before attach
  --ducklake-load              Run LOAD ducklake before attach
  --ducklake-data-path         Data path for DuckLake table storage
  --ducklake-read-only         Attach DuckLake in read-only mode
  --ducklake-create-if-not-exists  Create catalog if it does not exist
  --ducklake-override-data-path    Override data path for existing catalog
  --ducklake-data-inlining-row-limit  Inline row limit for data storage
  --ducklake-encrypted         Enable encryption for the metadata catalog
  --ducklake-metadata-catalog  Override metadata catalog name
  --ducklake-meta-parameter-name  Set meta parameter name for metadata storage

Database Filtering:
  By default, only tables from the current database are introspected. This prevents
  returning tables from all attached databases in MotherDuck workspaces.

  Use --database to specify a different database, or --all-databases to introspect
  all attached databases.

Examples:
  # Local DuckDB file
  bun x duckdb-introspect --url ./my-database.duckdb --out ./schema.ts

  # MotherDuck (requires MOTHERDUCK_TOKEN env var)
  MOTHERDUCK_TOKEN=xxx bun x duckdb-introspect --url md: --database my_cloud_db --out ./schema.ts

  # DuckLake local catalog with data path
  bun x duckdb-introspect --url :memory: --ducklake-catalog ./ducklake.duckdb \\
    --ducklake-data-path ./ducklake-data --out ./schema.ts

  # DuckLake on MotherDuck
  MOTHERDUCK_TOKEN=xxx bun x duckdb-introspect --url md: \\
    --ducklake-catalog md:__ducklake_metadata_my_db --out ./schema.ts
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.url) {
    printHelp();
    throw new CliUsageError('Missing required --url');
  }

  const instanceOptions =
    options.url.startsWith('md:') && process.env.MOTHERDUCK_TOKEN
      ? { motherduck_token: process.env.MOTHERDUCK_TOKEN }
      : undefined;

  const instance = await DuckDBInstance.create(options.url, instanceOptions);
  const connection = await instance.connect();
  const db = drizzle(connection);

  try {
    if (options.ducklake) {
      await configureDuckLake(connection, options.ducklake);
    }

    const result = await introspect(db, {
      database: options.database,
      allDatabases: options.allDatabases,
      schemas: options.schemas,
      includeViews: options.includeViews,
      useCustomTimeTypes: options.useCustomTimeTypes,
      importBasePath: options.importBasePath,
    });

    await mkdir(path.dirname(options.outFile), { recursive: true });
    await writeFile(options.outFile, result.files.schemaTs, 'utf8');
    if (options.outMeta) {
      await mkdir(path.dirname(options.outMeta), { recursive: true });
      await writeFile(
        options.outMeta,
        JSON.stringify(result.files.metaJson, null, 2),
        'utf8'
      );
    }

    console.log(`Wrote schema to ${options.outFile}`);
    if (options.outMeta) {
      console.log(`Wrote metadata to ${options.outMeta}`);
    }
  } finally {
    await closeClientConnection(connection);
    await closeDuckDbInstance(instance);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    if (err instanceof CliUsageError) {
      console.error('Run duckdb-introspect --help to see available options.');
      process.exit(2);
    }
    process.exit(1);
  });

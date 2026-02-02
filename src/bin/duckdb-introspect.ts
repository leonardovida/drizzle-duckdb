#!/usr/bin/env node
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { drizzle } from '../index.ts';
import { configureDuckLake, type DuckLakeConfig } from '../ducklake.ts';
import { introspect } from '../introspect.ts';

interface CliOptions {
  url?: string;
  database?: string;
  allDatabases: boolean;
  schemas?: string[];
  outFile: string;
  outMeta?: string;
  includeViews: boolean;
  useCustomTimeTypes: boolean;
  importBasePath?: string;
  ducklake?: DuckLakeConfig;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outFile: path.resolve(process.cwd(), 'drizzle/schema.ts'),
    outMeta: undefined,
    allDatabases: false,
    includeViews: false,
    useCustomTimeTypes: true,
  };

  const ensureDuckLakeConfig = (): DuckLakeConfig => {
    if (!options.ducklake) {
      options.ducklake = { catalog: '' };
    }
    return options.ducklake;
  };

  const ensureDuckLakeAttachOptions = (): NonNullable<
    DuckLakeConfig['attachOptions']
  > => {
    const config = ensureDuckLakeConfig();
    if (!config.attachOptions) {
      config.attachOptions = {};
    }
    return config.attachOptions;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--url':
        options.url = argv[++i];
        break;
      case '--database':
      case '--db':
        options.database = argv[++i];
        break;
      case '--all-databases':
        options.allDatabases = true;
        break;
      case '--schema':
      case '--schemas':
        options.schemas = argv[++i]
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--out':
      case '--outFile':
        options.outFile = path.resolve(
          process.cwd(),
          argv[++i] ?? 'drizzle/schema.ts'
        );
        break;
      case '--out-json':
      case '--outJson':
      case '--json':
        options.outMeta = path.resolve(
          process.cwd(),
          argv[++i] ?? 'drizzle/schema.meta.json'
        );
        break;
      case '--include-views':
      case '--includeViews':
        options.includeViews = true;
        break;
      case '--use-pg-time':
        options.useCustomTimeTypes = false;
        break;
      case '--import-base':
        options.importBasePath = argv[++i];
        break;
      case '--ducklake-catalog':
        ensureDuckLakeConfig().catalog = argv[++i] ?? '';
        break;
      case '--ducklake-alias':
        ensureDuckLakeConfig().alias = argv[++i];
        break;
      case '--ducklake-no-use':
        ensureDuckLakeConfig().use = false;
        break;
      case '--ducklake-install':
        ensureDuckLakeConfig().install = true;
        break;
      case '--ducklake-load':
        ensureDuckLakeConfig().load = true;
        break;
      case '--ducklake-data-path':
        ensureDuckLakeAttachOptions().dataPath = argv[++i];
        break;
      case '--ducklake-read-only':
        ensureDuckLakeAttachOptions().readOnly = true;
        break;
      case '--ducklake-create-if-not-exists':
        ensureDuckLakeAttachOptions().createIfNotExists = true;
        break;
      case '--ducklake-override-data-path':
        ensureDuckLakeAttachOptions().overrideDataPath = true;
        break;
      case '--ducklake-data-inlining-row-limit': {
        const value = argv[++i];
        const parsed = value ? Number(value) : NaN;
        if (Number.isFinite(parsed)) {
          ensureDuckLakeAttachOptions().dataInliningRowLimit = parsed;
        }
        break;
      }
      case '--ducklake-encrypted':
        ensureDuckLakeAttachOptions().encrypted = true;
        break;
      case '--ducklake-metadata-catalog':
        ensureDuckLakeAttachOptions().metadataCatalog = argv[++i];
        break;
      case '--ducklake-meta-parameter-name':
        ensureDuckLakeAttachOptions().metaParameterName = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith('-')) {
          console.warn(`Unknown option ${arg}`);
        }
    }
  }

  return options;
}

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
  --json           Optional JSON metadata output (default: ./drizzle/schema.meta.json)
  --include-views  Include views in the generated schema
  --use-pg-time    Use pg-core timestamp/date/time instead of DuckDB custom helpers
  --import-base    Override import path for duckdb helpers (default: package name)
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
  if (!options.url) {
    printHelp();
    throw new Error('Missing required --url');
  }

  const instanceOptions =
    options.url.startsWith('md:') && process.env.MOTHERDUCK_TOKEN
      ? { motherduck_token: process.env.MOTHERDUCK_TOKEN }
      : undefined;

  const instance = await DuckDBInstance.create(options.url, instanceOptions);
  const connection = await instance.connect();
  const db = drizzle(connection);

  try {
    if (options.ducklake && !options.ducklake.catalog) {
      throw new Error('DuckLake requires --ducklake-catalog');
    }
    if (options.ducklake?.catalog) {
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
    if (
      'closeSync' in connection &&
      typeof connection.closeSync === 'function'
    ) {
      connection.closeSync();
    }
    if ('closeSync' in instance && typeof instance.closeSync === 'function') {
      instance.closeSync();
    } else if ('close' in instance && typeof instance.close === 'function') {
      await instance.close();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import path from 'node:path';
import process from 'node:process';
import type { DuckLakeConfig } from '../ducklake.ts';

export interface CliOptions {
  help: boolean;
  url?: string;
  database?: string;
  bigintMode?: 'bigint' | 'number';
  allDatabases: boolean;
  schemas?: string[];
  outFile: string;
  outMeta?: string;
  includeViews: boolean;
  useCustomTimeTypes: boolean;
  importBasePath?: string;
  ducklake?: DuckLakeConfig;
}

/** Invalid command line usage. The CLI reports it and exits with code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
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
    // Consumes the next argument, rejecting a missing value or another flag
    // so `--url --out x.ts` does not open a database named `--out`.
    const requireValue = (): string => {
      const value = argv[i + 1];
      if (
        value === undefined ||
        (value.startsWith('-') && !/^-\d/.test(value))
      ) {
        throw new CliUsageError(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--url':
        options.url = requireValue();
        break;
      case '--database':
      case '--db':
        options.database = requireValue();
        break;
      case '--all-databases':
        options.allDatabases = true;
        break;
      case '--bigint-mode': {
        const mode = requireValue();
        if (mode !== 'bigint' && mode !== 'number')
          throw new CliUsageError('--bigint-mode must be bigint or number');
        options.bigintMode = mode;
        break;
      }
      case '--schema':
      case '--schemas':
        options.schemas = requireValue()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--out':
      case '--outFile':
        options.outFile = path.resolve(process.cwd(), requireValue());
        break;
      case '--out-json':
      case '--outJson':
      case '--json':
        options.outMeta = path.resolve(process.cwd(), requireValue());
        break;
      case '--include-views':
      case '--includeViews':
        options.includeViews = true;
        break;
      case '--use-pg-time':
        options.useCustomTimeTypes = false;
        break;
      case '--import-base':
        options.importBasePath = requireValue();
        break;
      case '--ducklake-catalog':
        ensureDuckLakeConfig().catalog = requireValue();
        break;
      case '--ducklake-alias':
        ensureDuckLakeConfig().alias = requireValue();
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
        ensureDuckLakeAttachOptions().dataPath = requireValue();
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
        const value = requireValue();
        if (!/^\d+$/.test(value)) {
          throw new CliUsageError(
            `Invalid value for ${arg}: expected a non-negative integer, got ${JSON.stringify(value)}`
          );
        }
        ensureDuckLakeAttachOptions().dataInliningRowLimit = Number(value);
        break;
      }
      case '--ducklake-encrypted':
        ensureDuckLakeAttachOptions().encrypted = true;
        break;
      case '--ducklake-metadata-catalog':
        ensureDuckLakeAttachOptions().metadataCatalog = requireValue();
        break;
      case '--ducklake-meta-parameter': {
        const value = requireValue();
        const separator = value.indexOf('=');
        if (separator <= 0) {
          throw new CliUsageError(
            `Invalid value for ${arg}: expected KEY=VALUE, got ${JSON.stringify(value)}`
          );
        }
        const attachOptions = ensureDuckLakeAttachOptions();
        attachOptions.metaParameters = {
          ...attachOptions.metaParameters,
          [value.slice(0, separator)]: value.slice(separator + 1),
        };
        break;
      }
      case '--ducklake-meta-parameter-name':
        // DuckLake has no META_PARAMETER_NAME option, so this never worked.
        throw new CliUsageError(
          `${arg} is no longer supported. Use --ducklake-meta-parameter KEY=VALUE, which emits META_<KEY> 'VALUE'.`
        );
      case '--help':
      case '-h':
        options.help = true;
        return options;
      default:
        throw new CliUsageError(
          arg.startsWith('-')
            ? `Unknown option ${arg}`
            : `Unexpected argument ${JSON.stringify(arg)}`
        );
    }
  }

  if (options.ducklake && !options.ducklake.catalog) {
    throw new CliUsageError('DuckLake requires --ducklake-catalog');
  }

  return options;
}

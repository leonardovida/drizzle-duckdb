import { sql, type SQLWrapper } from 'drizzle-orm';
import { isSQLWrapper, type SQL } from 'drizzle-orm/sql/sql';

export interface MotherDuckAccessTokenRow {
  token_name: string;
  token_type: string;
  created_ts: Date | string;
  expire_at: Date | string | null;
}

export interface MotherDuckRequiredResource {
  name: string | null;
  alias: string | null;
  url: string | null;
  id: string | null;
  resource_type: string | null;
}

export function mdAccessTokens(): SQL {
  return sql`md_access_tokens()`;
}

export function mdListDives(): SQL {
  return sql`md_list_dives()`;
}

export type MotherDuckRunMode = 'auto' | 'local' | 'remote';

export type MotherDuckTableFunction =
  | 'read_parquet'
  | 'parquet_scan'
  | 'read_csv'
  | 'read_csv_auto'
  | 'read_json'
  | 'read_json_auto'
  | 'read_ndjson'
  | 'read_ndjson_auto'
  | 'read_json_objects'
  | 'read_json_objects_auto'
  | 'read_ndjson_objects'
  | 'read_text'
  | 'read_blob'
  | 'delta_scan'
  | 'iceberg_scan';

type MotherDuckSqlArgument =
  | SQLWrapper
  | string
  | number
  | boolean
  | readonly unknown[];

export interface MotherDuckTableFunctionOptions {
  mdRun?: MotherDuckRunMode;
  named?: Record<string, MotherDuckSqlArgument | undefined>;
}

const motherDuckTableFunctionNames = new Set<MotherDuckTableFunction>([
  'read_parquet',
  'parquet_scan',
  'read_csv',
  'read_csv_auto',
  'read_json',
  'read_json_auto',
  'read_ndjson',
  'read_ndjson_auto',
  'read_json_objects',
  'read_json_objects_auto',
  'read_ndjson_objects',
  'read_text',
  'read_blob',
  'delta_scan',
  'iceberg_scan',
]);

function tableFunctionArg(value: MotherDuckSqlArgument): SQLWrapper {
  return isSQLWrapper(value) ? value : sql.param(value);
}

function assertTableFunctionName(
  name: MotherDuckTableFunction
): MotherDuckTableFunction {
  if (!motherDuckTableFunctionNames.has(name)) {
    throw new Error(`Unsupported MotherDuck table function "${name}"`);
  }
  return name;
}

function assertNamedParameterName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid MotherDuck table function parameter "${name}"`);
  }
  return name;
}

function assertRunMode(mode: MotherDuckRunMode): MotherDuckRunMode {
  if (mode !== 'auto' && mode !== 'local' && mode !== 'remote') {
    throw new Error(`Invalid MotherDuck mdRun mode "${String(mode)}"`);
  }
  return mode;
}

export function motherDuckTableFunction(
  name: MotherDuckTableFunction,
  args: readonly MotherDuckSqlArgument[] = [],
  options: MotherDuckTableFunctionOptions = {}
): SQL {
  const chunks: SQL[] = args.map((arg) => sql`${tableFunctionArg(arg)}`);

  for (const [paramName, value] of Object.entries(options.named ?? {})) {
    if (value !== undefined) {
      chunks.push(
        sql`${sql.raw(assertNamedParameterName(paramName))} = ${tableFunctionArg(
          value
        )}`
      );
    }
  }

  if (options.mdRun) {
    chunks.push(sql`md_run = ${assertRunMode(options.mdRun)}`);
  }

  return sql`${sql.raw(assertTableFunctionName(name))}(${sql.join(
    chunks,
    sql`, `
  )})`;
}

export const motherDuckReadParquet = (
  path: MotherDuckSqlArgument,
  options?: MotherDuckTableFunctionOptions
) => motherDuckTableFunction('read_parquet', [path], options);

export const motherDuckReadCsvAuto = (
  path: MotherDuckSqlArgument,
  options?: MotherDuckTableFunctionOptions
) => motherDuckTableFunction('read_csv_auto', [path], options);

export const motherDuckReadJsonAuto = (
  path: MotherDuckSqlArgument,
  options?: MotherDuckTableFunctionOptions
) => motherDuckTableFunction('read_json_auto', [path], options);

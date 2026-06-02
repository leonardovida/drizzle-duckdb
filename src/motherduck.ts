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

export interface MotherDuckFlightSummaryRow {
  flight_id: string;
  flight_name: string;
  schedule_cron: string | null;
  schedule_status: string | null;
  status: string;
  current_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface MotherDuckFlightVersionRow {
  version_id: string;
  flight_id: string;
  flight_version: number;
  created_at: Date | string;
  access_token_name: string;
  flight_secret_names: string[];
  config: Record<string, string> | Map<string, string> | null;
  source_code: string;
  requirements_txt: string | null;
}

export interface MotherDuckFlightRunRow {
  run_id: string;
  flight_id: string;
  flight_name: string;
  flight_version: number;
  run_number: number | bigint;
  is_scheduled: boolean;
  status: string;
  created_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  scheduled_at: Date | string | null;
  cancelled_at: Date | string | null;
  exit_code: number | null;
}

export interface MotherDuckFlightLogsRow {
  logs: string;
}

export interface MotherDuckFlightDeleteRow {
  deleted_count: number | bigint;
}

export interface MotherDuckFlightCancelRunRow {
  canceled_count: number | bigint;
}

/** @deprecated Use MotherDuckFlightSummaryRow. */
export interface MotherDuckJobSummaryRow {
  job_id: string;
  job_name: string;
  schedule_cron: string | null;
  schedule_status: string | null;
  status: string;
  current_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** @deprecated Use MotherDuckFlightVersionRow. */
export interface MotherDuckJobVersionRow {
  version_id: string;
  job_id: string;
  version: number;
  created_at: Date | string;
  md_token_name: string;
  md_secret_names: string[];
  config: Record<string, string> | Map<string, string> | null;
  source_code: string;
  requirements_txt: string | null;
}

/** @deprecated Use MotherDuckFlightRunRow. */
export interface MotherDuckJobRunRow {
  run_id: string;
  job_id: string;
  job_name: string;
  job_version: number;
  run_number: number | bigint;
  is_scheduled: boolean;
  status: string;
  created_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  scheduled_at: Date | string | null;
  cancelled_at: Date | string | null;
  exit_code: number | null;
}

/** @deprecated Use MotherDuckFlightLogsRow. */
export interface MotherDuckJobRunLogsRow {
  logs: string;
}

/** @deprecated Use MotherDuckFlightDeleteRow. */
export interface MotherDuckJobDeleteRow {
  deleted_count: number | bigint;
}

/** @deprecated Use MotherDuckFlightCancelRunRow. */
export interface MotherDuckJobCancelRunRow {
  canceled_count: number | bigint;
}

export interface MotherDuckPaginationOptions {
  limit?: number | SQLWrapper;
  offset?: number | SQLWrapper;
}

export interface MotherDuckCreateFlightOptions {
  name: string | SQLWrapper;
  accessTokenName: string | SQLWrapper;
  sourceCode: string | SQLWrapper;
  flightSecretNames?: readonly string[] | SQLWrapper;
  scheduleCron?: string | SQLWrapper;
  config?: Record<string, string> | SQLWrapper;
  requirementsTxt?: string | SQLWrapper;
}

export interface MotherDuckUpdateFlightOptions {
  flightId: string | SQLWrapper;
  name?: string | SQLWrapper;
  scheduleCron?: string | SQLWrapper;
  config?: Record<string, string> | SQLWrapper;
  sourceCode?: string | SQLWrapper;
  requirementsTxt?: string | SQLWrapper;
  accessTokenName?: string | SQLWrapper;
  flightSecretNames?: readonly string[] | SQLWrapper;
}

/** @deprecated Use MotherDuckCreateFlightOptions. */
export interface MotherDuckCreateJobOptions {
  name: string | SQLWrapper;
  mdTokenName: string | SQLWrapper;
  sourceCode: string | SQLWrapper;
  mdSecretNames?: readonly string[] | SQLWrapper;
  scheduleCron?: string | SQLWrapper;
  config?: Record<string, string> | SQLWrapper;
  requirementsTxt?: string | SQLWrapper;
}

/** @deprecated Use MotherDuckUpdateFlightOptions. */
export interface MotherDuckUpdateJobOptions {
  jobId: string | SQLWrapper;
  name?: string | SQLWrapper;
  scheduleCron?: string | SQLWrapper;
  config?: Record<string, string> | SQLWrapper;
  sourceCode?: string | SQLWrapper;
  requirementsTxt?: string | SQLWrapper;
  mdTokenName?: string | SQLWrapper;
  mdSecretNames?: readonly string[] | SQLWrapper;
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
  | bigint
  | boolean
  | readonly unknown[]
  | null;

export interface MotherDuckTableFunctionOptions {
  mdRun?: MotherDuckRunMode;
  named?: Record<string, MotherDuckSqlArgument | undefined>;
}

type NamedParameter = {
  name: string;
  value: MotherDuckSqlArgument | undefined;
};

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

function motherDuckArg(value: MotherDuckSqlArgument): SQLWrapper {
  return value !== null && isSQLWrapper(value) ? value : sql.param(value);
}

function motherDuckMapArg(
  value: Record<string, string> | SQLWrapper
): SQLWrapper {
  if (isSQLWrapper(value)) {
    return value;
  }

  return sql`MAP(${sql.param(Object.keys(value))}, ${sql.param(
    Object.values(value)
  )})`;
}

function motherDuckNamedParams(parameters: NamedParameter[]): SQL {
  const chunks: SQL[] = [];

  for (const { name, value } of parameters) {
    if (value !== undefined) {
      chunks.push(sql`${sql.raw(name)} = ${motherDuckArg(value)}`);
    }
  }

  return sql.join(chunks, sql`, `);
}

function motherDuckPagedNamedParams(
  options: MotherDuckPaginationOptions = {}
): SQL {
  return motherDuckNamedParams([
    { name: '"LIMIT"', value: options.limit },
    { name: '"OFFSET"', value: options.offset },
  ]);
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

export function mdAccessTokens(): SQL {
  return sql`md_access_tokens()`;
}

export function mdListDives(): SQL {
  return sql`md_list_dives()`;
}

export function motherDuckTableFunction(
  name: MotherDuckTableFunction,
  args: readonly MotherDuckSqlArgument[] = [],
  options: MotherDuckTableFunctionOptions = {}
): SQL {
  const chunks: SQL[] = args.map((arg) => sql`${motherDuckArg(arg)}`);

  for (const [paramName, value] of Object.entries(options.named ?? {})) {
    if (value !== undefined) {
      chunks.push(
        sql`${sql.raw(assertNamedParameterName(paramName))} = ${motherDuckArg(
          value
        )}`
      );
    }
  }

  if (options.mdRun) {
    chunks.push(sql`md_run = ${motherDuckArg(assertRunMode(options.mdRun))}`);
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

export function mdFlights(options: MotherDuckPaginationOptions = {}): SQL {
  return sql`md_flights(${motherDuckPagedNamedParams(options)})`;
}

export function mdCreateFlight(options: MotherDuckCreateFlightOptions): SQL {
  return sql`md_create_flight(${motherDuckNamedParams([
    { name: 'name', value: options.name },
    { name: 'access_token_name', value: options.accessTokenName },
    { name: 'source_code', value: options.sourceCode },
    { name: 'flight_secret_names', value: options.flightSecretNames },
    { name: 'schedule_cron', value: options.scheduleCron },
    {
      name: 'config',
      value:
        options.config === undefined
          ? undefined
          : motherDuckMapArg(options.config),
    },
    { name: 'requirements_txt', value: options.requirementsTxt },
  ])})`;
}

export function mdGetFlight(flightId: string | SQLWrapper): SQL {
  return sql`md_get_flight(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
  ])})`;
}

export function mdUpdateFlight(options: MotherDuckUpdateFlightOptions): SQL {
  return sql`md_update_flight(${motherDuckNamedParams([
    { name: 'flight_id', value: options.flightId },
    { name: 'name', value: options.name },
    { name: 'schedule_cron', value: options.scheduleCron },
    {
      name: 'config',
      value:
        options.config === undefined
          ? undefined
          : motherDuckMapArg(options.config),
    },
    { name: 'source_code', value: options.sourceCode },
    { name: 'requirements_txt', value: options.requirementsTxt },
    { name: 'access_token_name', value: options.accessTokenName },
    { name: 'flight_secret_names', value: options.flightSecretNames },
  ])})`;
}

export function mdDeleteFlight(flightId: string | SQLWrapper): SQL {
  return sql`md_delete_flight(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
  ])})`;
}

export function mdRunFlight(flightId: string | SQLWrapper): SQL {
  return sql`md_run_flight(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
  ])})`;
}

export function mdCancelFlightRun(
  flightId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return sql`md_cancel_flight_run(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
    { name: 'run_number', value: runNumber },
  ])})`;
}

export function mdFlightRuns(
  flightId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return sql`md_flight_runs(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
    { name: '"LIMIT"', value: options.limit },
    { name: '"OFFSET"', value: options.offset },
  ])})`;
}

export function mdFlightLogs(
  flightId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return sql`md_flight_logs(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
    { name: 'run_number', value: runNumber },
  ])})`;
}

export function mdFlightVersions(
  flightId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return sql`md_flight_versions(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
    { name: '"LIMIT"', value: options.limit },
    { name: '"OFFSET"', value: options.offset },
  ])})`;
}

export function mdGetFlightVersion(
  flightId: string | SQLWrapper,
  versionNumber: number | SQLWrapper
): SQL {
  return sql`md_get_flight_version(${motherDuckNamedParams([
    { name: 'flight_id', value: flightId },
    { name: 'version_number', value: versionNumber },
  ])})`;
}

/** @deprecated Use mdFlights. */
export function mdJobs(options: MotherDuckPaginationOptions = {}): SQL {
  return sql`md_jobs(${motherDuckPagedNamedParams(options)})`;
}

/** @deprecated Use mdCreateFlight. */
export function mdCreateJob(options: MotherDuckCreateJobOptions): SQL {
  return sql`md_create_job(${motherDuckNamedParams([
    { name: 'name', value: options.name },
    { name: 'md_token_name', value: options.mdTokenName },
    { name: 'source_code', value: options.sourceCode },
    { name: 'md_secret_names', value: options.mdSecretNames },
    { name: 'schedule_cron', value: options.scheduleCron },
    {
      name: 'config',
      value:
        options.config === undefined
          ? undefined
          : motherDuckMapArg(options.config),
    },
    { name: 'requirements_txt', value: options.requirementsTxt },
  ])})`;
}

/** @deprecated Use mdGetFlight. */
export function mdGetJob(jobId: string | SQLWrapper): SQL {
  return sql`md_get_job(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
  ])})`;
}

/** @deprecated Use mdUpdateFlight. */
export function mdUpdateJob(options: MotherDuckUpdateJobOptions): SQL {
  return sql`md_update_job(${motherDuckNamedParams([
    { name: 'job_id', value: options.jobId },
    { name: 'name', value: options.name },
    { name: 'schedule_cron', value: options.scheduleCron },
    {
      name: 'config',
      value:
        options.config === undefined
          ? undefined
          : motherDuckMapArg(options.config),
    },
    { name: 'source_code', value: options.sourceCode },
    { name: 'requirements_txt', value: options.requirementsTxt },
    { name: 'md_token_name', value: options.mdTokenName },
    { name: 'md_secret_names', value: options.mdSecretNames },
  ])})`;
}

/** @deprecated Use mdDeleteFlight. */
export function mdDeleteJob(jobId: string | SQLWrapper): SQL {
  return sql`md_delete_job(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
  ])})`;
}

/** @deprecated Use mdRunFlight. */
export function mdRunJob(jobId: string | SQLWrapper): SQL {
  return sql`md_run_job(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
  ])})`;
}

/** @deprecated Use mdCancelFlightRun. */
export function mdCancelJobRun(
  jobId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return sql`md_cancel_job_run(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
    { name: 'run_number', value: runNumber },
  ])})`;
}

/** @deprecated Use mdFlightRuns. */
export function mdJobRuns(
  jobId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return sql`md_job_runs(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
    { name: '"LIMIT"', value: options.limit },
    { name: '"OFFSET"', value: options.offset },
  ])})`;
}

/** @deprecated Use mdFlightLogs. */
export function mdJobRunLogs(
  jobId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return sql`md_job_run_logs(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
    { name: 'run_number', value: runNumber },
  ])})`;
}

/** @deprecated Use mdFlightVersions. */
export function mdJobVersions(
  jobId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return sql`md_job_versions(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
    { name: '"LIMIT"', value: options.limit },
    { name: '"OFFSET"', value: options.offset },
  ])})`;
}

/** @deprecated Use mdGetFlightVersion. */
export function mdGetJobVersion(
  jobId: string | SQLWrapper,
  versionNumber: number | SQLWrapper
): SQL {
  return sql`md_get_job_version(${motherDuckNamedParams([
    { name: 'job_id', value: jobId },
    { name: 'version_number', value: versionNumber },
  ])})`;
}

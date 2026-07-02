import { sql, type SQLWrapper } from 'drizzle-orm';
import { isSQLWrapper, type SQL } from 'drizzle-orm/sql/sql';

export interface MotherDuckAccessTokenRow {
  token_name: string;
  token_type: string;
  created_ts: Date | string;
  expire_at: Date | string | null;
}

export interface MotherDuckAccessTokenOptions {
  activeOnly?: boolean;
  asOf?: string | SQLWrapper;
}

export interface MotherDuckRequiredResource {
  name: string | null;
  alias: string | null;
  url: string | null;
  id: string | null;
  resource_type: string | null;
}

export interface MotherDuckDiveSummaryRow {
  id: string;
  title: string;
  description: string | null;
  owner_id: string;
  current_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  owner_name: string;
  required_resources?: MotherDuckRequiredResource[] | null;
}

export interface MotherDuckDiveDetailRow extends MotherDuckDiveSummaryRow {
  version_id: string;
  version_storage_url: string;
  version_description: string | null;
  version_created_at: Date | string;
  version_api_version: number;
  content: string;
  version_required_resources?: MotherDuckRequiredResource[] | null;
}

export type MotherDuckDiveCreateRow = Omit<
  MotherDuckDiveDetailRow,
  'content' | 'required_resources' | 'version_required_resources'
>;

export interface MotherDuckDiveVersionSummaryRow {
  id: string;
  version: number;
  storage_url: string;
  description: string | null;
  created_at: Date | string;
  api_version: number;
}

export interface MotherDuckDiveVersionDetailRow extends MotherDuckDiveVersionSummaryRow {
  content: string;
}

export interface MotherDuckDiveDeleteRow {
  success: boolean;
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
  config: Record<string, string> | Map<string, string> | null;
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

export interface MotherDuckListDivesOptions extends MotherDuckPaginationOptions {
  includeOrgShares?: boolean | SQLWrapper;
}

export interface MotherDuckCreateDiveOptions {
  title: string | SQLWrapper;
  content: string | SQLWrapper;
  description?: string | SQLWrapper | null;
  apiVersion?: number | SQLWrapper;
}

export interface MotherDuckUpdateDiveMetadataOptions {
  id: string | SQLWrapper;
  title?: string | SQLWrapper | null;
  description?: string | SQLWrapper | null;
}

export interface MotherDuckUpdateDiveContentOptions {
  id: string | SQLWrapper;
  content: string | SQLWrapper;
  description?: string | SQLWrapper | null;
  apiVersion?: number | SQLWrapper;
}

export interface MotherDuckCreateFlightOptions {
  name: string | SQLWrapper;
  accessTokenName?: string | SQLWrapper;
  sourceCode: string | SQLWrapper;
  flightSecretNames?: readonly (string | null)[] | SQLWrapper | null;
  scheduleCron?: string | SQLWrapper | null;
  config?: Record<string, string | null> | SQLWrapper | null;
  requirementsTxt?: string | SQLWrapper | null;
}

export interface MotherDuckUpdateFlightOptions {
  flightId: string | SQLWrapper;
  name?: string | SQLWrapper | null;
  scheduleCron?: string | SQLWrapper | null;
  config?: Record<string, string | null> | SQLWrapper | null;
  sourceCode?: string | SQLWrapper | null;
  requirementsTxt?: string | SQLWrapper | null;
  accessTokenName?: string | SQLWrapper | null;
  flightSecretNames?: readonly (string | null)[] | SQLWrapper | null;
}

export interface MotherDuckRunFlightOptions {
  config?: Record<string, string | null> | SQLWrapper | null;
}

/** @deprecated Use MotherDuckCreateFlightOptions. */
export interface MotherDuckCreateJobOptions {
  name: string | SQLWrapper;
  mdTokenName: string | SQLWrapper;
  sourceCode: string | SQLWrapper;
  mdSecretNames?: readonly (string | null)[] | SQLWrapper | null;
  scheduleCron?: string | SQLWrapper | null;
  config?: Record<string, string | null> | SQLWrapper | null;
  requirementsTxt?: string | SQLWrapper | null;
}

/** @deprecated Use MotherDuckUpdateFlightOptions. */
export interface MotherDuckUpdateJobOptions {
  jobId: string | SQLWrapper;
  name?: string | SQLWrapper | null;
  scheduleCron?: string | SQLWrapper | null;
  config?: Record<string, string | null> | SQLWrapper | null;
  sourceCode?: string | SQLWrapper | null;
  requirementsTxt?: string | SQLWrapper | null;
  mdTokenName?: string | SQLWrapper | null;
  mdSecretNames?: readonly (string | null)[] | SQLWrapper | null;
}

export type MotherDuckRunMode = 'auto' | 'local' | 'remote';

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

const motherDuckTableFunctionNameList = [
  'read_parquet',
  'parquet_scan',
  'parquet_schema',
  'parquet_metadata',
  'parquet_file_metadata',
  'parquet_kv_metadata',
  'parquet_bloom_probe',
  'parquet_full_metadata',
  'read_csv',
  'read_csv_auto',
  'sniff_csv',
  'read_json',
  'read_json_auto',
  'read_ndjson',
  'read_ndjson_auto',
  'read_json_objects',
  'read_json_objects_auto',
  'read_ndjson_objects',
  'read_text',
  'read_blob',
  'read_duckdb',
  'read_avro',
  'glob',
  'dbgen',
  'dsdgen',
  'delta_scan',
  'delta_list_files',
  'iceberg_snapshots',
  'iceberg_metadata',
  'iceberg_scan',
  'iceberg_partition_stats',
  'iceberg_column_stats',
  'st_read',
  'st_readosm',
  'ducklake_snapshots',
  'ducklake_list_files',
  'ducklake_table_info',
  'ducklake_table_insertions',
  'ducklake_table_deletions',
  'ducklake_current_snapshot',
  'ducklake_last_committed_snapshot',
  'ducklake_merge_adjacent_files',
  'ducklake_cleanup_old_files',
  'ducklake_expire_snapshots',
  'ducklake_set_option',
  'ducklake_options',
  'ducklake_add_data_files',
  'ducklake_delete_orphaned_files',
  'ducklake_set_commit_message',
  'ducklake_rewrite_data_files',
  'ducklake_flush_inlined_data',
  'ducklake_settings',
] as const;

export type MotherDuckTableFunction =
  (typeof motherDuckTableFunctionNameList)[number];

const motherDuckTableFunctionNames = new Set<MotherDuckTableFunction>(
  motherDuckTableFunctionNameList
);

function motherDuckArg(value: MotherDuckSqlArgument): SQLWrapper {
  return value !== null && isSQLWrapper(value) ? value : sql.param(value);
}

function motherDuckMapArg(
  value: Record<string, string | null> | SQLWrapper | null
): SQLWrapper {
  if (value !== null && isSQLWrapper(value)) {
    return value;
  }

  if (value === null) {
    return sql.param(null);
  }

  validateMotherDuckConfigMap(value);

  return sql`MAP(${sql.param(Object.keys(value))}, ${sql.param(
    Object.values(value)
  )})`;
}

function validateMotherDuckConfigMap(
  value: Record<string, string | null>
): void {
  for (const [key, configValue] of Object.entries(value)) {
    if (key === '') {
      throw new Error('MotherDuck Flight config keys must not be empty');
    }

    if (key.includes('=')) {
      throw new Error(
        `MotherDuck Flight config key "${key}" must not contain "="`
      );
    }

    if (key.includes('\0')) {
      throw new Error(
        `MotherDuck Flight config key "${key}" must not contain a NULL byte`
      );
    }

    if (configValue?.includes('\0')) {
      throw new Error(
        `MotherDuck Flight config value for key "${key}" must not contain a NULL byte`
      );
    }
  }
}

function motherDuckOptionalMapArg(
  value: Record<string, string | null> | SQLWrapper | null | undefined
): SQLWrapper | undefined {
  return value === undefined ? undefined : motherDuckMapArg(value);
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

function motherDuckNamedFunction(
  name: string,
  parameters: NamedParameter[] = []
): SQL {
  return sql`${sql.raw(name)}(${motherDuckNamedParams(parameters)})`;
}

function motherDuckPagedParams(
  options: MotherDuckPaginationOptions = {}
): NamedParameter[] {
  return [
    { name: '"LIMIT"', value: options.limit },
    { name: '"OFFSET"', value: options.offset },
  ];
}

function motherDuckDivePagedParams(
  options: MotherDuckListDivesOptions = {}
): NamedParameter[] {
  return [
    ...motherDuckPagedParams(options),
    { name: 'include_org_shares', value: options.includeOrgShares },
  ];
}

function motherDuckIdParams(
  idName: string,
  idValue: string | SQLWrapper
): NamedParameter[] {
  return [{ name: idName, value: idValue }];
}

function motherDuckIdPagedParams(
  idName: string,
  idValue: string | SQLWrapper,
  options: MotherDuckPaginationOptions
): NamedParameter[] {
  return [
    ...motherDuckIdParams(idName, idValue),
    ...motherDuckPagedParams(options),
  ];
}

function motherDuckIdRunParams(
  idName: string,
  idValue: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): NamedParameter[] {
  return [
    ...motherDuckIdParams(idName, idValue),
    { name: 'run_number', value: runNumber },
  ];
}

function motherDuckIdVersionParams(
  idName: string,
  idValue: string | SQLWrapper,
  versionNumber: number | SQLWrapper
): NamedParameter[] {
  return [
    ...motherDuckIdParams(idName, idValue),
    { name: 'version_number', value: versionNumber },
  ];
}

function motherDuckIdVersionParam(
  idValue: string | SQLWrapper,
  version: number | SQLWrapper
): NamedParameter[] {
  return [
    ...motherDuckIdParams('id', idValue),
    { name: 'version', value: version },
  ];
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

export function mdAccessTokens(
  options: MotherDuckAccessTokenOptions = {}
): SQL {
  if (!options.activeOnly) {
    return sql`md_access_tokens()`;
  }

  const asOf =
    options.asOf === undefined ? sql`now()` : motherDuckArg(options.asOf);

  return sql`(select token_name, token_type, created_ts, expire_at from md_access_tokens() where expire_at is null or expire_at > ${asOf}) as active_access_tokens`;
}

export function mdListDives(options: MotherDuckListDivesOptions = {}): SQL {
  return motherDuckNamedFunction(
    'md_list_dives',
    motherDuckDivePagedParams(options)
  );
}

export function mdGetDive(id: string | SQLWrapper): SQL {
  return motherDuckNamedFunction('md_get_dive', motherDuckIdParams('id', id));
}

export function mdCreateDive(options: MotherDuckCreateDiveOptions): SQL {
  return motherDuckNamedFunction('md_create_dive', [
    { name: 'title', value: options.title },
    { name: 'content', value: options.content },
    { name: 'description', value: options.description },
    { name: 'api_version', value: options.apiVersion },
  ]);
}

export function mdUpdateDiveMetadata(
  options: MotherDuckUpdateDiveMetadataOptions
): SQL {
  return motherDuckNamedFunction('md_update_dive_metadata', [
    { name: 'id', value: options.id },
    { name: 'title', value: options.title },
    { name: 'description', value: options.description },
  ]);
}

export function mdUpdateDiveContent(
  options: MotherDuckUpdateDiveContentOptions
): SQL {
  return motherDuckNamedFunction('md_update_dive_content', [
    { name: 'id', value: options.id },
    { name: 'content', value: options.content },
    { name: 'description', value: options.description },
    { name: 'api_version', value: options.apiVersion },
  ]);
}

export function mdDeleteDive(id: string | SQLWrapper): SQL {
  return motherDuckNamedFunction(
    'md_delete_dive',
    motherDuckIdParams('id', id)
  );
}

export function mdListDiveVersions(
  id: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return motherDuckNamedFunction(
    'md_list_dive_versions',
    motherDuckIdPagedParams('id', id, options)
  );
}

export function mdGetDiveVersion(
  id: string | SQLWrapper,
  version: number | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_get_dive_version',
    motherDuckIdVersionParam(id, version)
  );
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
  return motherDuckNamedFunction('md_flights', motherDuckPagedParams(options));
}

export function mdCreateFlight(options: MotherDuckCreateFlightOptions): SQL {
  return motherDuckNamedFunction('md_create_flight', [
    { name: 'name', value: options.name },
    { name: 'access_token_name', value: options.accessTokenName },
    { name: 'source_code', value: options.sourceCode },
    { name: 'flight_secret_names', value: options.flightSecretNames },
    { name: 'schedule_cron', value: options.scheduleCron },
    { name: 'config', value: motherDuckOptionalMapArg(options.config) },
    { name: 'requirements_txt', value: options.requirementsTxt },
  ]);
}

export function mdGetFlight(flightId: string | SQLWrapper): SQL {
  return motherDuckNamedFunction(
    'md_get_flight',
    motherDuckIdParams('flight_id', flightId)
  );
}

export function mdUpdateFlight(options: MotherDuckUpdateFlightOptions): SQL {
  return motherDuckNamedFunction('md_update_flight', [
    { name: 'flight_id', value: options.flightId },
    { name: 'name', value: options.name },
    { name: 'schedule_cron', value: options.scheduleCron },
    { name: 'config', value: motherDuckOptionalMapArg(options.config) },
    { name: 'source_code', value: options.sourceCode },
    { name: 'requirements_txt', value: options.requirementsTxt },
    { name: 'access_token_name', value: options.accessTokenName },
    { name: 'flight_secret_names', value: options.flightSecretNames },
  ]);
}

export function mdDeleteFlight(flightId: string | SQLWrapper): SQL {
  return motherDuckNamedFunction(
    'md_delete_flight',
    motherDuckIdParams('flight_id', flightId)
  );
}

export function mdRunFlight(
  flightId: string | SQLWrapper,
  options: MotherDuckRunFlightOptions = {}
): SQL {
  return motherDuckNamedFunction('md_run_flight', [
    { name: 'flight_id', value: flightId },
    { name: 'config', value: motherDuckOptionalMapArg(options.config) },
  ]);
}

export function mdCancelFlightRun(
  flightId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_cancel_flight_run',
    motherDuckIdRunParams('flight_id', flightId, runNumber)
  );
}

export function mdFlightRuns(
  flightId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return motherDuckNamedFunction(
    'md_flight_runs',
    motherDuckIdPagedParams('flight_id', flightId, options)
  );
}

export function mdFlightLogs(
  flightId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_flight_logs',
    motherDuckIdRunParams('flight_id', flightId, runNumber)
  );
}

export function mdFlightVersions(
  flightId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return motherDuckNamedFunction(
    'md_flight_versions',
    motherDuckIdPagedParams('flight_id', flightId, options)
  );
}

export function mdGetFlightVersion(
  flightId: string | SQLWrapper,
  versionNumber: number | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_get_flight_version',
    motherDuckIdVersionParams('flight_id', flightId, versionNumber)
  );
}

/** @deprecated Use mdFlights. */
export function mdJobs(options: MotherDuckPaginationOptions = {}): SQL {
  return motherDuckNamedFunction('md_jobs', motherDuckPagedParams(options));
}

/** @deprecated Use mdCreateFlight. */
export function mdCreateJob(options: MotherDuckCreateJobOptions): SQL {
  return motherDuckNamedFunction('md_create_job', [
    { name: 'name', value: options.name },
    { name: 'md_token_name', value: options.mdTokenName },
    { name: 'source_code', value: options.sourceCode },
    { name: 'md_secret_names', value: options.mdSecretNames },
    { name: 'schedule_cron', value: options.scheduleCron },
    { name: 'config', value: motherDuckOptionalMapArg(options.config) },
    { name: 'requirements_txt', value: options.requirementsTxt },
  ]);
}

/** @deprecated Use mdGetFlight. */
export function mdGetJob(jobId: string | SQLWrapper): SQL {
  return motherDuckNamedFunction(
    'md_get_job',
    motherDuckIdParams('job_id', jobId)
  );
}

/** @deprecated Use mdUpdateFlight. */
export function mdUpdateJob(options: MotherDuckUpdateJobOptions): SQL {
  return motherDuckNamedFunction('md_update_job', [
    { name: 'job_id', value: options.jobId },
    { name: 'name', value: options.name },
    { name: 'schedule_cron', value: options.scheduleCron },
    { name: 'config', value: motherDuckOptionalMapArg(options.config) },
    { name: 'source_code', value: options.sourceCode },
    { name: 'requirements_txt', value: options.requirementsTxt },
    { name: 'md_token_name', value: options.mdTokenName },
    { name: 'md_secret_names', value: options.mdSecretNames },
  ]);
}

/** @deprecated Use mdDeleteFlight. */
export function mdDeleteJob(jobId: string | SQLWrapper): SQL {
  return motherDuckNamedFunction(
    'md_delete_job',
    motherDuckIdParams('job_id', jobId)
  );
}

/** @deprecated Use mdRunFlight. */
export function mdRunJob(jobId: string | SQLWrapper): SQL {
  return motherDuckNamedFunction(
    'md_run_job',
    motherDuckIdParams('job_id', jobId)
  );
}

/** @deprecated Use mdCancelFlightRun. */
export function mdCancelJobRun(
  jobId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_cancel_job_run',
    motherDuckIdRunParams('job_id', jobId, runNumber)
  );
}

/** @deprecated Use mdFlightRuns. */
export function mdJobRuns(
  jobId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return motherDuckNamedFunction(
    'md_job_runs',
    motherDuckIdPagedParams('job_id', jobId, options)
  );
}

/** @deprecated Use mdFlightLogs. */
export function mdJobRunLogs(
  jobId: string | SQLWrapper,
  runNumber: number | bigint | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_job_run_logs',
    motherDuckIdRunParams('job_id', jobId, runNumber)
  );
}

/** @deprecated Use mdFlightVersions. */
export function mdJobVersions(
  jobId: string | SQLWrapper,
  options: MotherDuckPaginationOptions = {}
): SQL {
  return motherDuckNamedFunction(
    'md_job_versions',
    motherDuckIdPagedParams('job_id', jobId, options)
  );
}

/** @deprecated Use mdGetFlightVersion. */
export function mdGetJobVersion(
  jobId: string | SQLWrapper,
  versionNumber: number | SQLWrapper
): SQL {
  return motherDuckNamedFunction(
    'md_get_job_version',
    motherDuckIdVersionParams('job_id', jobId, versionNumber)
  );
}

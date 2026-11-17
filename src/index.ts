export * from './driver.ts';
export * from './session.ts';
// Explicit lists keep the literal builders, type parsers and other internal
// helpers of columns.ts, introspect.ts and client.ts out of the public API.
export {
  duckDbList,
  duckDbArray,
  duckDbMap,
  duckDbStruct,
  duckDbUnion,
  duckDbJson,
  duckDbBlob,
  duckDbInet,
  duckDbInterval,
  duckDbTimestamp,
  duckDbDate,
  duckDbTime,
  duckDbArrayContains,
  duckDbArrayContained,
  duckDbArrayOverlaps,
  type ArrayPredicateValue,
  type DuckDbUnionValue,
} from './columns.ts';
export * from './migrator.ts';
export {
  introspect,
  type IntrospectOptions,
  type IntrospectedColumn,
  type IntrospectedConstraint,
  type IntrospectedTable,
  type IntrospectResult,
} from './introspect.ts';
export {
  isPool,
  prepareParams,
  closeClientConnection,
  closeDuckDbInstance,
  executeOnClient,
  executeArraysOnClient,
  executeInBatches,
  executeInBatchesRaw,
  executeArrowOnClient,
  appendRowsOnClient,
  type DuckDBExecutionClient,
  type DuckDBClientLike,
  type RowData,
  type DuckDBConnectionPool,
  type ExecuteClientOptions,
  type DateParamType,
  type ExecuteArraysResult,
  type PrepareParamsOptions,
  type ExecuteInBatchesOptions,
  type ExecuteBatchesRawChunk,
  type AppendTarget,
} from './client.ts';
export * from './pool.ts';
export * from './olap.ts';
// Explicit list keeps the node-api binding helpers in value-wrappers.ts internal.
export {
  wrapperToNodeApiValue,
  DUCKDB_VALUE_MARKER,
  isDuckDBWrapper,
  wrapArray,
  wrapBlob,
  wrapJson,
  wrapList,
  wrapMap,
  wrapStruct,
  wrapTimestamp,
  type AnyDuckDBValueWrapper,
  type DuckDBValueWrapper,
  type ArrayValueWrapper,
  type BlobValueWrapper,
  type JsonValueWrapper,
  type ListValueWrapper,
  type MapValueWrapper,
  type StructValueWrapper,
  type TimestampValueWrapper,
  type DuckDBValueKind,
} from './value-wrappers.ts';
export * from './operators.ts';
export * from './pgduck.ts';
export * from './motherduck.ts';
export * from './jev.ts';
export * from './prompt.ts';
export {
  configureDuckLake,
  duckLakeMergeAdjacentFiles,
  wrapDuckLakePool,
  type DuckLakeAttachOptions,
  type DuckLakeConfig,
  type DuckLakeMergeAdjacentFilesOptions,
  type DuckLakeMergeAdjacentFilesRow,
} from './ducklake.ts';
export { DuckDBDialect } from './dialect.ts';
export { DuckDBSelectBuilder } from './select-builder.ts';
export type { DuckDbMigrationConfig } from './migration-config.ts';

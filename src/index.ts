export * from './driver.ts';
export * from './session.ts';
export * from './columns.ts';
export * from './migrator.ts';
export * from './introspect.ts';
export * from './client.ts';
export * from './pool.ts';
export { getPreparedStatementCacheStats } from './prepared-statement-cache.ts';
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
export * from './options.ts';
export * from './operators.ts';
export * from './pgduck.ts';
export * from './motherduck.ts';
export * from './jev.ts';
export {
  configureDuckLake,
  wrapDuckLakePool,
  type DuckLakeAttachOptions,
  type DuckLakeConfig,
} from './ducklake.ts';
export { DuckDBDialect } from './dialect.ts';
export { DuckDBSelectBuilder } from './select-builder.ts';
export type { DuckDbMigrationConfig } from './migration-config.ts';

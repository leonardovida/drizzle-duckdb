// Client-safe entrypoint exposing schema builder utilities without pulling
// the DuckDB Node API bindings. Intended for generated schemas and browser use.
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
} from './columns.ts';

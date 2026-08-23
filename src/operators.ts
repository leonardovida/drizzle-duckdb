/**
 * DuckDB-native names for the array predicate helpers.
 */
export {
  duckDbArrayContains as arrayHasAll,
  duckDbArrayOverlaps as arrayHasAny,
  duckDbArrayContained as arrayContainedBy,
} from './columns.ts';

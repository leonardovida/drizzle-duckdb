export type PrepareCacheOption = boolean | number | { size?: number };

export interface PreparedStatementCacheConfig {
  size: number;
}

const DEFAULT_PREPARED_CACHE_SIZE = 32;

export function normalizePositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

export function resolvePrepareCacheOption(
  option?: PrepareCacheOption
): PreparedStatementCacheConfig | undefined {
  if (!option) return undefined;

  if (option === true) {
    return { size: DEFAULT_PREPARED_CACHE_SIZE };
  }

  if (typeof option === 'number') {
    return {
      size: normalizePositiveInteger(option, DEFAULT_PREPARED_CACHE_SIZE),
    };
  }

  return {
    size: normalizePositiveInteger(
      option.size ?? DEFAULT_PREPARED_CACHE_SIZE,
      DEFAULT_PREPARED_CACHE_SIZE
    ),
  };
}

import { describe, expect, test } from 'vitest';
import { resolvePrepareCacheOption } from '../src/options.ts';

describe('prepare cache options', () => {
  test('floors fractional cache sizes', () => {
    expect(resolvePrepareCacheOption(3.9)).toEqual({ size: 3 });
    expect(resolvePrepareCacheOption({ size: 2.2 })).toEqual({ size: 2 });
  });

  test('falls back when cache sizes are not finite', () => {
    expect(resolvePrepareCacheOption(Number.POSITIVE_INFINITY)).toEqual({
      size: 32,
    });
    expect(resolvePrepareCacheOption({ size: Number.NaN })).toEqual({
      size: 32,
    });
  });
});

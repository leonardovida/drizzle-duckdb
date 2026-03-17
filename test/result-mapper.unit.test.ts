import { describe, expect, test } from 'vitest';
import {
  normalizeInet,
  normalizeTimestamp,
  normalizeTimestampString,
  normalizeDateString,
  normalizeDateValue,
  normalizeTime,
  normalizeInterval,
} from '../src/sql/result-mapper.ts';

describe('normalizeInet', () => {
  test('converts numeric IPv4 address to dotted quad notation', () => {
    const result = normalizeInet({ address: 3232235777, mask: 32 });
    expect(result).toBe('192.168.1.1');
  });

  test('converts bigint IPv4 address to dotted quad notation', () => {
    const result = normalizeInet({ address: BigInt(3232235777), mask: 32 });
    expect(result).toBe('192.168.1.1');
  });

  test('appends mask suffix when mask is not 32', () => {
    const result = normalizeInet({ address: 3232235776, mask: 24 });
    expect(result).toBe('192.168.1.0/24');
  });

  test('does not append /32 suffix when mask is 32', () => {
    const result = normalizeInet({ address: 3232235777, mask: 32 });
    expect(result).toBe('192.168.1.1');
  });

  test('handles missing mask (defaults to no suffix)', () => {
    const result = normalizeInet({ address: 2130706433 });
    expect(result).toBe('127.0.0.1');
  });

  test('uses fallback toString() for out-of-range address', () => {
    const outOfRange = {
      address: BigInt('340282366920938463463374607431768211455'), // > maxIpv4
      toString: () => '::1',
    };
    const result = normalizeInet(outOfRange);
    expect(result).toBe('::1');
  });

  test('returns original value for object without proper toString', () => {
    const obj = { address: BigInt('340282366920938463463374607431768211455') };
    const result = normalizeInet(obj);
    expect(result).toBe(obj);
  });

  test('passes through string values unchanged', () => {
    const result = normalizeInet('192.168.1.1');
    expect(result).toBe('192.168.1.1');
  });

  test('passes through null', () => {
    const result = normalizeInet(null);
    expect(result).toBe(null);
  });

  test('passes through undefined', () => {
    const result = normalizeInet(undefined);
    expect(result).toBe(undefined);
  });

  test('passes through number values', () => {
    const result = normalizeInet(12345);
    expect(result).toBe(12345);
  });

  test('handles empty object', () => {
    const result = normalizeInet({});
    expect(result).toEqual({});
  });

  test('converts zero address correctly', () => {
    const result = normalizeInet({ address: 0, mask: 0 });
    expect(result).toBe('0.0.0.0/0');
  });

  test('converts max IPv4 address correctly', () => {
    const result = normalizeInet({ address: 4294967295, mask: 32 });
    expect(result).toBe('255.255.255.255');
  });
});

describe('normalizeTimestampString', () => {
  test('converts Date to ISO string with space separator and +00 suffix (withTimezone: true)', () => {
    const date = new Date('2024-03-01T12:30:45.000Z');
    const result = normalizeTimestampString(date, true);
    expect(result).toBe('2024-03-01 12:30:45.000+00');
  });

  test('converts Date to ISO string without Z (withTimezone: false)', () => {
    const date = new Date('2024-03-01T12:30:45.000Z');
    const result = normalizeTimestampString(date, false);
    expect(result).toBe('2024-03-01 12:30:45.000');
  });

  test('replaces T with space in string', () => {
    const result = normalizeTimestampString('2024-03-01T12:30:45', true);
    expect(result).toBe('2024-03-01 12:30:45+00');
  });

  test('preserves existing +00 in string (withTimezone: true)', () => {
    const result = normalizeTimestampString('2024-03-01 12:30:45+00', true);
    expect(result).toBe('2024-03-01 12:30:45+00');
  });

  test('preserves existing negative offsets in string (withTimezone: true)', () => {
    const result = normalizeTimestampString('2024-03-01T12:30:45-05:00', true);
    expect(result).toBe('2024-03-01 12:30:45-05:00');
  });

  test('removes +00 suffix (withTimezone: false)', () => {
    const result = normalizeTimestampString('2024-03-01 12:30:45+00', false);
    expect(result).toBe('2024-03-01 12:30:45');
  });

  test('removes negative offsets from strings when withTimezone is false', () => {
    const result = normalizeTimestampString('2024-03-01T12:30:45-05:00', false);
    expect(result).toBe('2024-03-01 12:30:45');
  });

  test('passes through non-string non-Date values', () => {
    const result = normalizeTimestampString(12345, true);
    expect(result).toBe(12345);
  });

  test('passes through null', () => {
    const result = normalizeTimestampString(null, true);
    expect(result).toBe(null);
  });
});

describe('normalizeTimestamp', () => {
  test('returns Date unchanged', () => {
    const date = new Date('2024-03-01T12:30:45.000Z');
    const result = normalizeTimestamp(date, true);
    expect(result).toBe(date);
  });

  test('parses string ending with Z as Date', () => {
    const result = normalizeTimestamp('2024-03-01T12:30:45Z', true);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe('2024-03-01T12:30:45.000Z');
  });

  test('parses string with offset as Date', () => {
    const result = normalizeTimestamp('2024-03-01T12:30:45+05:00', true);
    expect(result).toBeInstanceOf(Date);
  });

  test('appends +00 to string without offset (withTimezone: false)', () => {
    const result = normalizeTimestamp('2024-03-01 12:30:45', false);
    expect(result).toBeInstanceOf(Date);
  });

  test('converts space to T in string', () => {
    const result = normalizeTimestamp('2024-03-01 12:30:45Z', true);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe('2024-03-01T12:30:45.000Z');
  });

  test('passes through non-string non-Date values', () => {
    const result = normalizeTimestamp(12345, true);
    expect(result).toBe(12345);
  });

  test('passes through null', () => {
    const result = normalizeTimestamp(null, true);
    expect(result).toBe(null);
  });
});

describe('normalizeDateString', () => {
  test('extracts YYYY-MM-DD from Date object', () => {
    const date = new Date('2024-03-15T12:30:45.000Z');
    const result = normalizeDateString(date);
    expect(result).toBe('2024-03-15');
  });

  test('extracts first 10 chars from string', () => {
    const result = normalizeDateString('2024-03-15T12:30:45');
    expect(result).toBe('2024-03-15');
  });

  test('returns short string as-is', () => {
    const result = normalizeDateString('2024-03');
    expect(result).toBe('2024-03');
  });

  test('passes through non-string non-Date values', () => {
    const result = normalizeDateString(12345);
    expect(result).toBe(12345);
  });

  test('passes through null', () => {
    const result = normalizeDateString(null);
    expect(result).toBe(null);
  });
});

describe('normalizeDateValue', () => {
  test('returns Date unchanged', () => {
    const date = new Date('2024-03-15T12:30:45.000Z');
    const result = normalizeDateValue(date);
    expect(result).toBe(date);
  });

  test('parses YYYY-MM-DD string to Date at midnight UTC', () => {
    const result = normalizeDateValue('2024-03-15');
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  test('truncates string with time component to date portion', () => {
    const result = normalizeDateValue('2024-03-15T12:30:45');
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  test('passes through non-string non-Date values', () => {
    const result = normalizeDateValue(12345);
    expect(result).toBe(12345);
  });

  test('passes through null', () => {
    const result = normalizeDateValue(null);
    expect(result).toBe(null);
  });
});

describe('normalizeTime', () => {
  test('converts bigint microseconds to HH:MM:SS.mmm format', () => {
    // 12:30:45.123 = (12*3600 + 30*60 + 45) * 1000 + 123 = 45045123 milliseconds
    // In microseconds: 45045123000
    const micros = BigInt(45045123000);
    const result = normalizeTime(micros);
    expect(result).toBe('12:30:45.123');
  });

  test('converts bigint zero to midnight', () => {
    const result = normalizeTime(BigInt(0));
    expect(result).toBe('00:00:00.000');
  });

  test('extracts time portion from Date object', () => {
    const date = new Date('2024-03-15T14:30:45.500Z');
    const result = normalizeTime(date);
    expect(result).toBe('14:30:45.500');
  });

  test('passes through string values', () => {
    const result = normalizeTime('12:30:45');
    expect(result).toBe('12:30:45');
  });

  test('passes through number values', () => {
    const result = normalizeTime(12345);
    expect(result).toBe(12345);
  });

  test('passes through null', () => {
    const result = normalizeTime(null);
    expect(result).toBe(null);
  });
});

describe('normalizeInterval', () => {
  test('formats single day without micros', () => {
    const result = normalizeInterval({ months: 0, days: 1 });
    expect(result).toBe('1 day');
  });

  test('formats multiple days without micros', () => {
    const result = normalizeInterval({ months: 0, days: 5 });
    expect(result).toBe('5 days');
  });

  test('formats days with micros as seconds', () => {
    const result = normalizeInterval({ months: 0, days: 2, micros: 3000000 });
    expect(result).toBe('2 days 3 seconds');
  });

  test('formats zero days with micros', () => {
    const result = normalizeInterval({ months: 0, days: 0, micros: 5000000 });
    expect(result).toBe('0 days 5 seconds');
  });

  test('passes through when months is not 0', () => {
    const interval = { months: 2, days: 5, micros: 0 };
    const result = normalizeInterval(interval);
    expect(result).toBe(interval);
  });

  test('passes through non-object values', () => {
    const result = normalizeInterval('1 day');
    expect(result).toBe('1 day');
  });

  test('passes through null', () => {
    const result = normalizeInterval(null);
    expect(result).toBe(null);
  });

  test('passes through object without required fields', () => {
    const obj = { foo: 'bar' };
    const result = normalizeInterval(obj);
    expect(result).toBe(obj);
  });

  test('handles string micros', () => {
    const result = normalizeInterval({ months: 0, days: 1, micros: '2000000' });
    expect(result).toBe('1 day 2 seconds');
  });

  test('handles zero micros', () => {
    const result = normalizeInterval({ months: 0, days: 3, micros: 0 });
    expect(result).toBe('3 days');
  });
});

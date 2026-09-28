const MICROS_PER_DAY = 86_400_000_000n;

function pad(value: bigint, length: number): string {
  return value.toString().padStart(length, '0');
}

/**
 * Format bigint TIME microseconds as HH:MM:SS.mmm, adding the microsecond
 * digits only when the value has sub-millisecond precision.
 */
export function timeFromMicros(value: bigint): string {
  if (value < 0n || value > MICROS_PER_DAY) {
    // Values outside a DuckDB TIME range keep the previous Date based
    // wrapping and RangeError behavior.
    const date = new Date(Number(value) / 1000);
    return date.toISOString().split('T')[1]!.replace('Z', '');
  }

  const hours = value / 3_600_000_000n;
  const minutes = (value / 60_000_000n) % 60n;
  const seconds = (value / 1_000_000n) % 60n;
  const micros = value % 1_000_000n;
  const fraction =
    micros % 1000n === 0n ? pad(micros / 1000n, 3) : pad(micros, 6);

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${fraction}`;
}

const TIMESTAMP_STRING_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export interface TimestampStringParts {
  date: string;
  time?: string;
  fraction?: string;
  /** `Z` or a `+HH:MM` / `-HH:MM` offset. */
  offset?: string;
}

function normalizeOffset(offset: string): string {
  if (offset.toUpperCase() === 'Z') {
    return 'Z';
  }
  const digits = offset.slice(1).replace(':', '');
  return `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`;
}

/**
 * Split an ISO-like timestamp string (`YYYY-MM-DD[( |T)HH:MM[:SS[.f]]][offset]`)
 * into its parts. Offsets may be `Z`, `+HH`, `+HHMM` or `+HH:MM`.
 */
export function parseTimestampString(
  value: string
): TimestampStringParts | undefined {
  const match = TIMESTAMP_STRING_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const [, date, time, fraction, offset] = match;
  return {
    date: date!,
    time,
    fraction,
    offset: offset ? normalizeOffset(offset) : undefined,
  };
}

/**
 * Build a string that `new Date()` parses, treating a missing offset as UTC.
 * Strings outside the ISO-like shape keep the older best effort handling.
 */
export function timestampStringToDateInput(
  value: string,
  parts: TimestampStringParts | undefined = parseTimestampString(value)
): string {
  if (parts) {
    const time = parts.time ?? '00:00';
    const fraction = parts.fraction ? `.${parts.fraction}` : '';
    return `${parts.date}T${time}${fraction}${parts.offset ?? 'Z'}`;
  }

  const normalized =
    !value.includes('T') && value.includes(' ')
      ? value.replace(' ', 'T')
      : value;
  return normalized.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
}

/** Sub-millisecond microseconds carried by a fractional seconds string. */
export function subMillisecondMicros(fraction: string | undefined): bigint {
  if (!fraction || fraction.length <= 3) {
    return 0n;
  }
  return BigInt(fraction.slice(3, 6).padEnd(3, '0'));
}

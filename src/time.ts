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

/**
 * Rewrite parsed timestamp parts as a UTC wall time (`YYYY-MM-DD HH:MM:SS`
 * plus the original fractional digits, without an offset). A missing offset
 * is read as UTC. Offsets are whole minutes, so the fraction is unchanged.
 */
export function utcTimestampString(
  parts: TimestampStringParts
): string | undefined {
  const date = new Date(
    `${parts.date}T${parts.time ?? '00:00'}${parts.offset ?? 'Z'}`
  );
  if (isNaN(date.getTime())) {
    return undefined;
  }
  const base = date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace('T', ' ');
  return parts.fraction ? `${base}.${parts.fraction}` : base;
}

/**
 * Format microseconds since the Unix epoch the way DuckDB prints a
 * TIMESTAMP: trailing fractional zeros are trimmed. `withTimezone` appends
 * `+00` because the value is rendered in UTC.
 */
export function timestampStringFromMicros(
  micros: bigint,
  withTimezone: boolean
): string {
  let seconds = micros / 1_000_000n;
  let fraction = micros % 1_000_000n;
  if (fraction < 0n) {
    seconds -= 1n;
    fraction += 1_000_000n;
  }
  const base = new Date(Number(seconds) * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace('T', ' ');
  const digits =
    fraction === 0n ? '' : `.${pad(fraction, 6).replace(/0+$/, '')}`;
  return `${base}${digits}${withTimezone ? '+00' : ''}`;
}

function pluralUnit(value: number, unit: string): string {
  return `${value} ${unit}${Math.abs(value) === 1 ? '' : 's'}`;
}

/**
 * Format INTERVAL parts the way DuckDB casts an INTERVAL to VARCHAR, for
 * example `1 year 2 months 3 days 04:05:06.5`. DuckDB parses this text back.
 */
export function intervalToString(
  months: number,
  days: number,
  micros: bigint
): string {
  const parts: string[] = [];
  const years = Math.trunc(months / 12);
  const extraMonths = months - years * 12;
  if (years !== 0) parts.push(pluralUnit(years, 'year'));
  if (extraMonths !== 0) parts.push(pluralUnit(extraMonths, 'month'));
  if (days !== 0) parts.push(pluralUnit(days, 'day'));
  if (micros !== 0n) {
    const negative = micros < 0n;
    const abs = negative ? -micros : micros;
    const hours = abs / 3_600_000_000n;
    const minutes = (abs / 60_000_000n) % 60n;
    const seconds = (abs / 1_000_000n) % 60n;
    const fraction = pad(abs % 1_000_000n, 6).replace(/0+$/, '');
    parts.push(
      `${negative ? '-' : ''}${pad(hours, 2)}:${pad(minutes, 2)}:${pad(
        seconds,
        2
      )}${fraction ? `.${fraction}` : ''}`
    );
  }
  return parts.length > 0 ? parts.join(' ') : '00:00:00';
}

/** Sub-millisecond microseconds carried by a fractional seconds string. */
export function subMillisecondMicros(fraction: string | undefined): bigint {
  if (!fraction || fraction.length <= 3) {
    return 0n;
  }
  return BigInt(fraction.slice(3, 6).padEnd(3, '0'));
}

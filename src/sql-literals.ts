import { sql, type SQL } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm/sql/sql';

export function formatLiteral(value: unknown, typeHint?: string): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  const upperType = typeHint?.toUpperCase() ?? '';
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }

  const str =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value) ?? String(value));

  const escaped = str.replace(/'/g, "''");
  if (
    upperType.includes('CHAR') ||
    upperType.includes('TEXT') ||
    upperType.includes('STRING') ||
    upperType.includes('VARCHAR')
  ) {
    return `'${escaped}'`;
  }

  return `'${escaped}'`;
}

export function buildListLiteral(values: unknown[], elementType?: string): SQL {
  if (values.length === 0) {
    return sql`[]`;
  }

  const chunks = values.map((value) =>
    typeof value === 'object' && !Array.isArray(value)
      ? sql`${value as SQLWrapper}`
      : sql.raw(formatLiteral(value, elementType))
  );

  return sql`list_value(${sql.join(chunks, sql.raw(', '))})`;
}

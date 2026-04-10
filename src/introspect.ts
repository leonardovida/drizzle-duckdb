import { sql, type SQL } from 'drizzle-orm';
import type { RowData } from './client.ts';
import type { DuckDBDatabase } from './driver.ts';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);

export interface IntrospectOptions {
  /**
   * Database/catalog to introspect. If not specified, uses the current database
   * (via `SELECT current_database()`). This prevents returning tables from all
   * attached databases in MotherDuck workspaces.
   */
  database?: string;
  /**
   * When true, introspects all attached databases instead of just the current one.
   * Ignored if `database` is explicitly set.
   * @default false
   */
  allDatabases?: boolean;
  schemas?: string[];
  includeViews?: boolean;
  useCustomTimeTypes?: boolean;
  mapJsonAsDuckDbJson?: boolean;
  importBasePath?: string;
}

interface DuckDbTableRow extends RowData {
  schema_name: string;
  table_name: string;
  table_type: string;
}

interface DuckDbColumnRow extends RowData {
  schema_name: string;
  table_name: string;
  column_name: string;
  column_index: number;
  column_default: string | null;
  is_nullable: boolean;
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  internal: boolean | null;
}

interface DuckDbConstraintRow extends RowData {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  constraint_text: string | null;
  constraint_column_names: string[] | null;
  referenced_table: string | null;
  referenced_column_names: string[] | null;
}

interface DuckDbIndexRow extends RowData {
  schema_name: string;
  table_name: string;
  index_name: string;
  is_unique: boolean | null;
  expressions: string | null;
}

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  columnDefault: string | null;
  nullable: boolean;
  characterLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
}

export interface IntrospectedConstraint {
  name: string;
  type: string;
  columns: string[];
  referencedTable?: {
    name: string;
    schema: string;
    columns: string[];
  };
  rawExpression?: string | null;
}

export interface IntrospectedTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: IntrospectedColumn[];
  constraints: IntrospectedConstraint[];
  indexes: DuckDbIndexRow[];
}

export interface IntrospectResult {
  files: {
    schemaTs: string;
    metaJson: IntrospectedTable[];
    relationsTs?: string;
  };
}

type ImportBuckets = {
  drizzle: Set<string>;
  pgCore: Set<string>;
  local: Set<string>;
};

export const DEFAULT_IMPORT_BASE = '@duckdbfan/drizzle-duckdb/helpers';

export async function introspect(
  db: DuckDBDatabase,
  opts: IntrospectOptions = {}
): Promise<IntrospectResult> {
  const database = await resolveDatabase(db, opts.database, opts.allDatabases);
  const schemas = await resolveSchemas(db, database, opts.schemas);
  const includeViews = opts.includeViews ?? false;

  const tables = await loadTables(db, database, schemas, includeViews);
  const columns = await loadColumns(db, database, schemas);
  const constraints = await loadConstraints(db, database, schemas);
  const indexes = await loadIndexes(db, database, schemas);

  const grouped = buildTables(tables, columns, constraints, indexes);

  const schemaTs = emitSchema(grouped, {
    useCustomTimeTypes: opts.useCustomTimeTypes ?? true,
    mapJsonAsDuckDbJson: opts.mapJsonAsDuckDbJson ?? true,
    importBasePath: opts.importBasePath ?? DEFAULT_IMPORT_BASE,
  });

  return {
    files: {
      schemaTs,
      metaJson: grouped,
    },
  };
}

async function resolveDatabase(
  db: DuckDBDatabase,
  targetDatabase?: string,
  allDatabases?: boolean
): Promise<string | null> {
  if (allDatabases) {
    return null;
  }
  if (targetDatabase) {
    return targetDatabase;
  }

  const rows = await db.execute<{ current_database: string }>(
    sql`SELECT current_database() as current_database`
  );
  return rows[0]?.current_database ?? null;
}

async function resolveSchemas(
  db: DuckDBDatabase,
  database: string | null,
  targetSchemas?: string[]
): Promise<string[]> {
  if (targetSchemas?.length) {
    return targetSchemas;
  }

  const databaseFilter = database
    ? sql`catalog_name = ${database}`
    : sql`1 = 1`;

  const rows = await db.execute<{ schema_name: string }>(
    sql`SELECT schema_name FROM information_schema.schemata WHERE ${databaseFilter}`
  );

  return rows
    .map((row) => row.schema_name)
    .filter((name) => !SYSTEM_SCHEMAS.has(name));
}

function buildOptionalEqualityFilter(
  columnName: string,
  value: string | null
): SQL {
  return value ? sql`${sql.raw(columnName)} = ${value}` : sql`1 = 1`;
}

function buildSchemaFilter(columnName: string, schemas: string[]): SQL {
  if (schemas.length === 0) {
    return sql`1 = 0`;
  }

  const schemaFragments = schemas.map((schema) => sql`${schema}`);
  return sql`${sql.raw(columnName)} IN (${sql.join(
    schemaFragments,
    sql.raw(', ')
  )})`;
}

async function loadTables(
  db: DuckDBDatabase,
  database: string | null,
  schemas: string[],
  includeViews: boolean
): Promise<DuckDbTableRow[]> {
  return await db.execute<DuckDbTableRow>(
    sql`
      SELECT table_schema as schema_name, table_name, table_type
      FROM information_schema.tables
      WHERE ${buildOptionalEqualityFilter('table_catalog', database)}
      AND ${buildSchemaFilter('table_schema', schemas)}
      AND ${includeViews ? sql`1 = 1` : sql`table_type = 'BASE TABLE'`}
      ORDER BY table_schema, table_name
    `
  );
}

async function loadColumns(
  db: DuckDBDatabase,
  database: string | null,
  schemas: string[]
): Promise<DuckDbColumnRow[]> {
  return await db.execute<DuckDbColumnRow>(
    sql`
      SELECT
        schema_name,
        table_name,
        column_name,
        column_index,
        column_default,
        is_nullable,
        data_type,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        internal
      FROM duckdb_columns()
      WHERE ${buildOptionalEqualityFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
      ORDER BY schema_name, table_name, column_index
    `
  );
}

async function loadConstraints(
  db: DuckDBDatabase,
  database: string | null,
  schemas: string[]
): Promise<DuckDbConstraintRow[]> {
  return await db.execute<DuckDbConstraintRow>(
    sql`
      SELECT
        schema_name,
        table_name,
        constraint_name,
        constraint_type,
        constraint_text,
        constraint_column_names,
        referenced_table,
        referenced_column_names
      FROM duckdb_constraints()
      WHERE ${buildOptionalEqualityFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
      ORDER BY schema_name, table_name, constraint_index
    `
  );
}

async function loadIndexes(
  db: DuckDBDatabase,
  database: string | null,
  schemas: string[]
): Promise<DuckDbIndexRow[]> {
  return await db.execute<DuckDbIndexRow>(
    sql`
      SELECT
        schema_name,
        table_name,
        index_name,
        is_unique,
        expressions
      FROM duckdb_indexes()
      WHERE ${buildOptionalEqualityFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
      ORDER BY schema_name, table_name, index_name
    `
  );
}

function buildTables(
  tables: DuckDbTableRow[],
  columns: DuckDbColumnRow[],
  constraints: DuckDbConstraintRow[],
  indexes: DuckDbIndexRow[]
): IntrospectedTable[] {
  const byTable: Record<string, IntrospectedTable> = {};
  for (const table of tables) {
    const key = tableKey(table.schema_name, table.table_name);
    byTable[key] = {
      schema: table.schema_name,
      name: table.table_name,
      kind: table.table_type === 'VIEW' ? 'view' : 'table',
      columns: [],
      constraints: [],
      indexes: [],
    };
  }

  for (const column of columns) {
    if (column.internal) {
      continue;
    }
    const key = tableKey(column.schema_name, column.table_name);
    const table = byTable[key];
    if (!table) {
      continue;
    }
    table.columns.push({
      name: column.column_name,
      dataType: column.data_type,
      columnDefault: column.column_default,
      nullable: column.is_nullable,
      characterLength: column.character_maximum_length,
      numericPrecision: column.numeric_precision,
      numericScale: column.numeric_scale,
    });
  }

  for (const constraint of constraints) {
    const key = tableKey(constraint.schema_name, constraint.table_name);
    const table = byTable[key];
    if (!table) {
      continue;
    }
    if (!constraint.constraint_column_names?.length) {
      continue;
    }
    table.constraints.push({
      name: constraint.constraint_name,
      type: constraint.constraint_type,
      columns: constraint.constraint_column_names ?? [],
      referencedTable:
        constraint.referenced_table && constraint.referenced_column_names
          ? {
              schema: constraint.schema_name,
              name: constraint.referenced_table,
              columns: constraint.referenced_column_names,
            }
          : undefined,
      rawExpression: constraint.constraint_text,
    });
  }

  for (const index of indexes) {
    const key = tableKey(index.schema_name, index.table_name);
    const table = byTable[key];
    if (!table) {
      continue;
    }
    table.indexes.push(index);
  }

  return Object.values(byTable);
}

interface EmitOptions {
  useCustomTimeTypes: boolean;
  mapJsonAsDuckDbJson: boolean;
  importBasePath: string;
}

function emitSchema(
  catalog: IntrospectedTable[],
  options: EmitOptions
): string {
  const imports: ImportBuckets = {
    drizzle: new Set(),
    pgCore: new Set(),
    local: new Set(),
  };

  imports.pgCore.add('pgSchema');

  const sorted = [...catalog].sort((a, b) =>
    a.schema === b.schema
      ? a.name.localeCompare(b.name)
      : a.schema.localeCompare(b.schema)
  );

  const lines: string[] = [];

  for (const schema of uniqueSchemas(sorted)) {
    imports.pgCore.add('pgSchema');
    const schemaVar = toSchemaIdentifier(schema);
    lines.push(
      `export const ${schemaVar} = pgSchema(${JSON.stringify(schema)});`,
      ''
    );

    const tables = sorted.filter((table) => table.schema === schema);
    for (const table of tables) {
      lines.push(...emitTable(schemaVar, table, imports, options));
      lines.push('');
    }
  }

  const importsBlock = renderImports(imports, options.importBasePath);
  return [importsBlock, ...lines].join('\n').trim() + '\n';
}

function emitTable(
  schemaVar: string,
  table: IntrospectedTable,
  imports: ImportBuckets,
  options: EmitOptions
): string[] {
  const tableVar = toIdentifier(table.name);
  const columnLines: string[] = [];
  for (const column of table.columns) {
    columnLines.push(
      `  ${columnProperty(column.name)}: ${emitColumn(
        column,
        imports,
        options
      )},`
    );
  }

  const constraintBlock = emitConstraints(table, imports);

  const tableLines: string[] = [];
  tableLines.push(
    `export const ${tableVar} = ${schemaVar}.table(${JSON.stringify(
      table.name
    )}, {`
  );
  tableLines.push(...columnLines);
  tableLines.push(
    `}${constraintBlock ? ',' : ''}${constraintBlock ? ` ${constraintBlock}` : ''});`
  );

  return tableLines;
}

function emitConstraints(
  table: IntrospectedTable,
  imports: ImportBuckets
): string {
  const constraints = table.constraints.filter((constraint) =>
    ['PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE'].includes(constraint.type)
  );
  if (!constraints.length) {
    return '';
  }

  const entries: string[] = [];

  for (const constraint of constraints) {
    const key = toIdentifier(constraint.name || `${table.name}_constraint`);
    if (constraint.type === 'PRIMARY KEY') {
      imports.pgCore.add('primaryKey');
      entries.push(
        `${key}: primaryKey({ columns: [${constraint.columns
          .map((col) => `t.${toIdentifier(col)}`)
          .join(', ')}], name: ${JSON.stringify(constraint.name)} })`
      );
    } else if (constraint.type === 'UNIQUE' && constraint.columns.length > 1) {
      imports.pgCore.add('unique');
      entries.push(
        `${key}: unique(${JSON.stringify(constraint.name)}).on(${constraint.columns
          .map((col) => `t.${toIdentifier(col)}`)
          .join(', ')})`
      );
    } else if (
      constraint.type === 'FOREIGN KEY' &&
      constraint.referencedTable
    ) {
      imports.pgCore.add('foreignKey');
      const targetTable = toIdentifier(constraint.referencedTable.name);
      entries.push(
        `${key}: foreignKey({ columns: [${constraint.columns
          .map((col) => `t.${toIdentifier(col)}`)
          .join(', ')}], foreignColumns: [${constraint.referencedTable.columns
          .map((col) => `${targetTable}.${toIdentifier(col)}`)
          .join(', ')}], name: ${JSON.stringify(constraint.name)} })`
      );
    } else if (
      constraint.type === 'UNIQUE' &&
      constraint.columns.length === 1
    ) {
      const columnName = constraint.columns[0];
      entries.push(
        `${key}: t.${toIdentifier(columnName)}.unique(${JSON.stringify(
          constraint.name
        )})`
      );
    }
  }

  if (!entries.length) {
    return '';
  }

  const lines: string[] = ['(t) => ({'];
  for (const entry of entries) {
    lines.push(`  ${entry},`);
  }
  lines.push('})');
  return lines.join('\n');
}

interface ColumnEmitOptions extends EmitOptions {}

function emitColumn(
  column: IntrospectedColumn,
  imports: ImportBuckets,
  options: ColumnEmitOptions
): string {
  const mapping = mapDuckDbType(column, imports, options);
  let builder = mapping.builder;

  if (!column.nullable) {
    builder += '.notNull()';
  }

  const defaultFragment = buildDefault(column.columnDefault);
  if (defaultFragment) {
    imports.drizzle.add('sql');
    builder += defaultFragment;
  }

  return builder;
}

export function buildDefault(defaultValue: string | null): string {
  if (!defaultValue) {
    return '';
  }
  const trimmed = defaultValue.trim();
  if (!trimmed || trimmed.toUpperCase() === 'NULL') {
    return '';
  }

  if (/^nextval\(/i.test(trimmed)) {
    return `.default(sql\`${trimmed}\`)`;
  }
  if (
    /^current_timestamp(?:\(\))?$/i.test(trimmed) ||
    /^now\(\)$/i.test(trimmed)
  ) {
    return `.defaultNow()`;
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return `.default(${trimmed})`;
  }
  const numberValue = Number(trimmed);
  if (!Number.isNaN(numberValue)) {
    return `.default(${trimmed})`;
  }
  const stringLiteralMatch = /^'(.*)'$/.exec(trimmed);
  if (stringLiteralMatch) {
    const value = stringLiteralMatch[1]?.replace(/''/g, "'");
    return `.default(${JSON.stringify(value)})`;
  }

  return '';
}

interface TypeMappingResult {
  builder: string;
}

export function normalizeTypeLiteral(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');

  const arrayMatch = /^(.*?)(\[(?:\d+)?\])$/.exec(trimmed);
  if (arrayMatch) {
    const [, base, suffix] = arrayMatch;
    return `${normalizeTypeLiteral(base ?? '')}${suffix ?? ''}`;
  }

  const canonicalPrefixes: Array<[RegExp, string]> = [
    [/^TIMESTAMP WITHOUT TIME ZONE\b/i, 'TIMESTAMP'],
    [/^TIMESTAMP WITH TIME ZONE\b/i, 'TIMESTAMP WITH TIME ZONE'],
    [/^TIMESTAMPTZ\b/i, 'TIMESTAMP WITH TIME ZONE'],
    [/^TIME WITHOUT TIME ZONE\b/i, 'TIME'],
    [/^CHARACTER VARYING\b/i, 'VARCHAR'],
    [/^CHARACTER\b/i, 'CHAR'],
  ];

  for (const [pattern, replacement] of canonicalPrefixes) {
    const match = pattern.exec(trimmed);
    if (match) {
      return `${replacement}${trimmed.slice(match[0].length)}`;
    }
  }

  const upper = trimmed.toUpperCase();
  const simpleTypes = new Set([
    'BOOLEAN',
    'BOOL',
    'SMALLINT',
    'INT2',
    'INT16',
    'TINYINT',
    'INTEGER',
    'INT',
    'INT4',
    'SIGNED',
    'BIGINT',
    'INT8',
    'UBIGINT',
    'DECIMAL',
    'NUMERIC',
    'REAL',
    'FLOAT4',
    'DOUBLE',
    'DOUBLE PRECISION',
    'FLOAT',
    'CHAR',
    'VARCHAR',
    'TEXT',
    'STRING',
    'UUID',
    'JSON',
    'INET',
    'INTERVAL',
    'BLOB',
    'BYTEA',
    'VARBINARY',
    'TIMESTAMP',
    'TIME',
    'DATE',
  ]);
  if (simpleTypes.has(upper)) {
    return upper;
  }

  return trimmed;
}

function mapDuckDbType(
  column: IntrospectedColumn,
  imports: ImportBuckets,
  options: ColumnEmitOptions
): TypeMappingResult {
  const raw = column.dataType.trim();
  const upper = normalizeTypeLiteral(raw);

  if (upper === 'BOOLEAN' || upper === 'BOOL') {
    imports.pgCore.add('boolean');
    return { builder: `boolean(${columnName(column.name)})` };
  }

  if (
    upper === 'SMALLINT' ||
    upper === 'INT2' ||
    upper === 'INT16' ||
    upper === 'TINYINT'
  ) {
    imports.pgCore.add('integer');
    return { builder: `integer(${columnName(column.name)})` };
  }

  if (
    upper === 'INTEGER' ||
    upper === 'INT' ||
    upper === 'INT4' ||
    upper === 'SIGNED'
  ) {
    imports.pgCore.add('integer');
    return { builder: `integer(${columnName(column.name)})` };
  }

  if (upper === 'BIGINT' || upper === 'INT8' || upper === 'UBIGINT') {
    imports.pgCore.add('bigint');
    // Drizzle's bigint helper requires an explicit mode. Default to 'number'
    // to mirror DuckDB's typical 64-bit integer behavior in JS.
    return {
      builder: `bigint(${columnName(column.name)}, { mode: 'number' })`,
    };
  }

  const decimalMatch = /^DECIMAL\((\d+),(\d+)\)/i.exec(upper);
  const numericMatch = /^NUMERIC\((\d+),(\d+)\)/i.exec(upper);
  if (decimalMatch || numericMatch) {
    imports.pgCore.add('numeric');
    const [, precision, scale] = decimalMatch ?? numericMatch!;
    return {
      builder: `numeric(${columnName(column.name)}, { precision: ${precision}, scale: ${scale} })`,
    };
  }

  if (upper.startsWith('DECIMAL') || upper.startsWith('NUMERIC')) {
    imports.pgCore.add('numeric');
    const precision = column.numericPrecision;
    const scale = column.numericScale;
    const options: string[] = [];
    if (precision !== null && precision !== undefined) {
      options.push(`precision: ${precision}`);
    }
    if (scale !== null && scale !== undefined) {
      options.push(`scale: ${scale}`);
    }
    const suffix = options.length ? `, { ${options.join(', ')} }` : '';
    return { builder: `numeric(${columnName(column.name)}${suffix})` };
  }

  if (upper === 'REAL' || upper === 'FLOAT4') {
    imports.pgCore.add('real');
    return { builder: `real(${columnName(column.name)})` };
  }

  if (upper === 'DOUBLE' || upper === 'DOUBLE PRECISION' || upper === 'FLOAT') {
    imports.pgCore.add('doublePrecision');
    return { builder: `doublePrecision(${columnName(column.name)})` };
  }

  const arrayMatch = /^(.*)\[(\d+)\]$/.exec(upper);
  if (arrayMatch) {
    imports.local.add('duckDbArray');
    const [, base, length] = arrayMatch;
    return {
      builder: `duckDbArray(${columnName(
        column.name
      )}, ${JSON.stringify(base)}, ${Number(length)})`,
    };
  }

  const listMatch = /^(.*)\[\]$/.exec(upper);
  if (listMatch) {
    imports.local.add('duckDbList');
    const [, base] = listMatch;
    return {
      builder: `duckDbList(${columnName(
        column.name
      )}, ${JSON.stringify(base)})`,
    };
  }

  if (upper.startsWith('CHAR(') || upper === 'CHAR') {
    imports.pgCore.add('char');
    const length = column.characterLength;
    const lengthPart =
      typeof length === 'number' ? `, { length: ${length} }` : '';
    return { builder: `char(${columnName(column.name)}${lengthPart})` };
  }

  if (upper.startsWith('VARCHAR')) {
    imports.pgCore.add('varchar');
    const length = column.characterLength;
    const lengthPart =
      typeof length === 'number' ? `, { length: ${length} }` : '';
    return { builder: `varchar(${columnName(column.name)}${lengthPart})` };
  }

  if (upper === 'TEXT' || upper === 'STRING') {
    imports.pgCore.add('text');
    return { builder: `text(${columnName(column.name)})` };
  }

  if (upper === 'UUID') {
    imports.pgCore.add('uuid');
    return { builder: `uuid(${columnName(column.name)})` };
  }

  if (upper === 'JSON') {
    if (options.mapJsonAsDuckDbJson) {
      imports.local.add('duckDbJson');
      return { builder: `duckDbJson(${columnName(column.name)})` };
    }
    imports.pgCore.add('text');
    return { builder: `text(${columnName(column.name)}) /* JSON */` };
  }

  if (upper.startsWith('ENUM')) {
    imports.pgCore.add('text');
    const enumLiteral = raw.replace(/^ENUM\s*/i, '').trim();
    return {
      builder: `text(${columnName(column.name)}) /* ENUM ${enumLiteral} */`,
    };
  }

  if (upper.startsWith('UNION')) {
    imports.pgCore.add('text');
    const unionLiteral = raw.replace(/^UNION\s*/i, '').trim();
    return {
      builder: `text(${columnName(column.name)}) /* UNION ${unionLiteral} */`,
    };
  }

  if (upper === 'INET') {
    imports.local.add('duckDbInet');
    return { builder: `duckDbInet(${columnName(column.name)})` };
  }

  if (upper === 'INTERVAL') {
    imports.local.add('duckDbInterval');
    return { builder: `duckDbInterval(${columnName(column.name)})` };
  }

  if (upper === 'BLOB' || upper === 'BYTEA' || upper === 'VARBINARY') {
    imports.local.add('duckDbBlob');
    return { builder: `duckDbBlob(${columnName(column.name)})` };
  }

  if (upper.startsWith('STRUCT')) {
    imports.local.add('duckDbStruct');
    const inner = upper.replace(/^STRUCT\s*\(/i, '').replace(/\)$/, '');
    const fields = parseStructFields(inner);
    const entries = fields.map(
      ({ name, type }) => `${JSON.stringify(name)}: ${JSON.stringify(type)}`
    );
    return {
      builder: `duckDbStruct(${columnName(
        column.name
      )}, { ${entries.join(', ')} })`,
    };
  }

  if (upper.startsWith('MAP(')) {
    imports.local.add('duckDbMap');
    const valueType = parseMapValue(upper);
    return {
      builder: `duckDbMap(${columnName(
        column.name
      )}, ${JSON.stringify(valueType)})`,
    };
  }

  if (upper.startsWith('TIMESTAMP WITH TIME ZONE')) {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbTimestamp');
    } else {
      imports.pgCore.add('timestamp');
    }
    const factory = options.useCustomTimeTypes
      ? `duckDbTimestamp(${columnName(column.name)}, { withTimezone: true })`
      : `timestamp(${columnName(column.name)}, { withTimezone: true })`;
    return { builder: factory };
  }

  if (
    upper === 'TIMESTAMP_NS' ||
    upper === 'TIMESTAMP_MS' ||
    upper === 'TIMESTAMP_S'
  ) {
    imports.local.add('duckDbTimestamp');
    return {
      builder: `duckDbTimestamp(${columnName(
        column.name
      )}, { duckDbType: ${JSON.stringify(upper)} })`,
    };
  }

  if (upper.startsWith('TIMESTAMP')) {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbTimestamp');
      return {
        builder: `duckDbTimestamp(${columnName(column.name)})`,
      };
    }
    imports.pgCore.add('timestamp');
    return { builder: `timestamp(${columnName(column.name)})` };
  }

  if (upper === 'TIME') {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbTime');
      return { builder: `duckDbTime(${columnName(column.name)})` };
    }
    imports.pgCore.add('time');
    return { builder: `time(${columnName(column.name)})` };
  }

  if (upper === 'TIME WITH TIME ZONE' || upper === 'TIMETZ') {
    imports.local.add('duckDbTime');
    return {
      builder: `duckDbTime(${columnName(column.name)}, { withTimezone: true })`,
    };
  }

  if (upper === 'TIME_NS') {
    imports.local.add('duckDbTime');
    return {
      builder: `duckDbTime(${columnName(
        column.name
      )}, { duckDbType: 'TIME_NS' })`,
    };
  }

  if (upper === 'DATE') {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbDate');
      return { builder: `duckDbDate(${columnName(column.name)})` };
    }
    imports.pgCore.add('date');
    return { builder: `date(${columnName(column.name)})` };
  }

  // Fallback: keep as text to avoid runtime failures.
  // Unknown types are mapped to text with a comment indicating the original type.
  imports.pgCore.add('text');
  return {
    builder: `text(${columnName(
      column.name
    )}) /* unsupported DuckDB type: ${upper} */`,
  };
}

export function parseStructFields(
  inner: string
): Array<{ name: string; type: string }> {
  const result: Array<{ name: string; type: string }> = [];
  for (const part of splitTopLevel(inner, ',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match =
      /^"([^"]+)"\s+(.*)$/i.exec(trimmed) ??
      /^([^\s"]+)\s+(.*)$/i.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, name, type] = match;
    result.push({ name, type: normalizeTypeLiteral(type) });
  }
  return result;
}

export function parseMapValue(raw: string): string {
  const inner = raw
    .trim()
    .replace(/^MAP\(/i, '')
    .replace(/\)$/, '');
  const parts = splitTopLevel(inner, ',');
  if (parts.length < 2) {
    return 'TEXT';
  }
  return normalizeTypeLiteral(parts[1] ?? 'TEXT');
}

export function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === delimiter && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  const parts = cleaned.split('_').filter(Boolean);
  const base = parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : capitalize(part.toLowerCase())
    )
    .join('');
  const candidate = base || 'item';
  return /^[A-Za-z_]/.test(candidate) ? candidate : `t${candidate}`;
}

function toSchemaIdentifier(schema: string): string {
  const base = toIdentifier(schema);
  return base.endsWith('Schema') ? base : `${base}Schema`;
}

function columnProperty(column: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    return toIdentifier(column);
  }
  return JSON.stringify(column);
}

function columnName(name: string): string {
  return JSON.stringify(name);
}

function capitalize(value: string): string {
  if (!value) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}

function uniqueSchemas(tables: IntrospectedTable[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const table of tables) {
    if (!seen.has(table.schema)) {
      seen.add(table.schema);
      result.push(table.schema);
    }
  }
  return result;
}

function renderImports(imports: ImportBuckets, importBasePath: string): string {
  const lines: string[] = [];
  const drizzle = [...imports.drizzle];
  if (drizzle.length) {
    lines.push(`import { ${drizzle.sort().join(', ')} } from 'drizzle-orm';`);
  }

  const pgCore = [...imports.pgCore];
  if (pgCore.length) {
    lines.push(
      `import { ${pgCore.sort().join(', ')} } from 'drizzle-orm/pg-core';`
    );
  }

  const local = [...imports.local];
  if (local.length) {
    lines.push(
      `import { ${local.sort().join(', ')} } from '${importBasePath}';`
    );
  }

  lines.push('');
  return lines.join('\n');
}

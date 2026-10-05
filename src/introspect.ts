import { sql, type SQL } from 'drizzle-orm';
import type { RowData } from './client.ts';
import type { DuckDBDatabase } from './driver.ts';
import { splitTopLevel } from './sql/split-top-level.ts';

export { splitTopLevel } from './sql/split-top-level.ts';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);

const CANONICAL_TYPE_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^TIMESTAMP WITHOUT TIME ZONE\b/i, 'TIMESTAMP'],
  [/^TIMESTAMP WITH TIME ZONE\b/i, 'TIMESTAMP WITH TIME ZONE'],
  [/^TIMESTAMPTZ\b/i, 'TIMESTAMP WITH TIME ZONE'],
  [/^TIME WITHOUT TIME ZONE\b/i, 'TIME'],
  [/^CHARACTER VARYING\b/i, 'VARCHAR'],
  [/^CHARACTER\b/i, 'CHAR'],
];

// UINTEGER reaches 4294967295, which is outside Postgres int4, but DuckDB
// returns every type here as a JS number, so integer() types reads correctly.
const INTEGER_TYPE_ALIASES = new Set([
  'SMALLINT',
  'INT2',
  'INT16',
  'TINYINT',
  'INTEGER',
  'INT',
  'INT4',
  'SIGNED',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
]);

// DuckDB returns these as JS bigint values, which a number mode would round.
const BIGINT_MODE_TYPES = new Set(['UBIGINT', 'HUGEINT', 'UHUGEINT']);

const SIMPLE_TYPE_NAMES = new Set([
  'BOOLEAN',
  'BOOL',
  ...INTEGER_TYPE_ALIASES,
  'BIGINT',
  'INT8',
  ...BIGINT_MODE_TYPES,
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

export interface IntrospectOptions {
  /** BIGINT output mode. Defaults to bigint to preserve all 64 bits. */
  bigintMode?: 'bigint' | 'number';
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
  database_name: string;
  schema_name: string;
  table_name: string;
  table_type: string;
}

interface DuckDbColumnRow extends RowData {
  database_name: string;
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
  database_name: string;
  schema_name: string;
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  constraint_text: string | null;
  constraint_column_names: string[] | null;
  referenced_table: string | null;
  referenced_column_names: string[] | null;
}

interface DuckDbTableSqlRow extends RowData {
  database_name: string;
  schema_name: string;
  table_name: string;
  sql: string | null;
}

interface DuckDbIndexRow extends RowData {
  database_name: string;
  schema_name: string;
  table_name: string;
  index_name: string;
  is_unique: boolean | null;
  expressions: string | null;
  sql: string | null;
}

export interface IntrospectedColumn {
  name: string;
  dataType: string;
  columnDefault: string | null;
  nullable: boolean;
  characterLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  /**
   * Generation expression of a generated column, or null for an ordinary
   * column. Undefined when the table definition could not be read.
   */
  generatedExpression?: string | null;
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
  /** Database (catalog) that owns the table. */
  database?: string;
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
    /** @deprecated Never populated. Will be removed in the next major version. */
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
  // Pin pooled clients and read one catalog snapshot for the entire operation.
  return db.transaction((tx) => introspectCatalog(tx, opts));
}

type CatalogReader = Pick<DuckDBDatabase, 'execute'>;

async function introspectCatalog(
  db: CatalogReader,
  opts: IntrospectOptions
): Promise<IntrospectResult> {
  const currentDatabase = await loadCurrentDatabase(db);
  const database =
    opts.database ?? (opts.allDatabases ? null : currentDatabase);
  const schemas = await resolveSchemas(db, database, opts.schemas);
  const includeViews = opts.includeViews ?? false;

  // Aggregate ordered metadata in one round trip. These catalogs contain
  // names, expressions and small ordinal numbers, rather than user values.
  const asJson = (query: SQL) =>
    sql`(select coalesce(to_json(list(catalog_row)), '[]'::json) from (${query}) catalog_row)`;
  const [catalog] = await db.execute<Record<string, string>>(sql`select
    ${asJson(tablesQuery(database, schemas, includeViews))} as tables,
    ${asJson(columnsQuery(database, schemas))} as columns,
    ${asJson(constraintsQuery(database, schemas))} as constraints,
    ${asJson(indexesQuery(database, schemas))} as indexes,
    ${asJson(tableSqlQuery(database, schemas))} as table_sql`);
  if (!catalog) throw new Error('DuckDB returned no catalog metadata');
  const tables = JSON.parse(catalog.tables!) as DuckDbTableRow[];
  const columns = JSON.parse(catalog.columns!) as DuckDbColumnRow[];
  const constraints = JSON.parse(catalog.constraints!) as DuckDbConstraintRow[];
  const indexes = JSON.parse(catalog.indexes!) as DuckDbIndexRow[];
  const tableSql = JSON.parse(catalog.table_sql!) as DuckDbTableSqlRow[];

  const grouped = buildTables(tables, columns, constraints, indexes, tableSql);

  const schemaTs = emitSchema(grouped, {
    useCustomTimeTypes: opts.useCustomTimeTypes ?? true,
    mapJsonAsDuckDbJson: opts.mapJsonAsDuckDbJson ?? true,
    importBasePath: opts.importBasePath ?? DEFAULT_IMPORT_BASE,
    currentDatabase,
    bigintMode: opts.bigintMode ?? 'bigint',
  });

  return {
    files: {
      schemaTs,
      metaJson: grouped,
    },
  };
}

async function loadCurrentDatabase(db: CatalogReader): Promise<string | null> {
  const rows = await db.execute<{ current_database: string }>(
    sql`SELECT current_database() as current_database`
  );
  return rows[0]?.current_database ?? null;
}

async function resolveSchemas(
  db: CatalogReader,
  database: string | null,
  targetSchemas?: string[]
): Promise<string[]> {
  if (targetSchemas?.length) {
    return targetSchemas;
  }

  const rows = await db.execute<{ schema_name: string }>(
    sql`SELECT schema_name FROM information_schema.schemata WHERE ${buildDatabaseFilter(
      'catalog_name',
      database
    )}`
  );

  return rows
    .map((row) => row.schema_name)
    .filter((name) => !SYSTEM_SCHEMAS.has(name));
}

// Catalogs skipped when introspecting all databases. `temp` holds
// connection-local tables and `system` holds DuckDB's own catalog.
const SKIPPED_CATALOGS = ['system', 'temp'];

function buildDatabaseFilter(columnName: string, database: string | null): SQL {
  if (database) {
    return sql`${sql.raw(columnName)} = ${database}`;
  }
  return sql`${sql.raw(columnName)} NOT IN (${sql.join(
    SKIPPED_CATALOGS.map((name) => sql`${name}`),
    sql.raw(', ')
  )})`;
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

function tablesQuery(
  database: string | null,
  schemas: string[],
  includeViews: boolean
): SQL {
  return sql`
      SELECT
        table_catalog as database_name,
        table_schema as schema_name,
        table_name,
        table_type
      FROM information_schema.tables
      WHERE ${buildDatabaseFilter('table_catalog', database)}
      AND ${buildSchemaFilter('table_schema', schemas)}
      AND ${includeViews ? sql`1 = 1` : sql`table_type = 'BASE TABLE'`}
      ORDER BY table_catalog, table_schema, table_name
    `;
}

function columnsQuery(database: string | null, schemas: string[]): SQL {
  return sql`
      SELECT
        database_name,
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
      WHERE ${buildDatabaseFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
      ORDER BY database_name, schema_name, table_name, column_index
    `;
}

function constraintsQuery(database: string | null, schemas: string[]): SQL {
  return sql`
      SELECT
        database_name,
        schema_name,
        table_name,
        constraint_name,
        constraint_type,
        constraint_text,
        constraint_column_names,
        referenced_table,
        referenced_column_names
      FROM duckdb_constraints()
      WHERE ${buildDatabaseFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
      ORDER BY database_name, schema_name, table_name, constraint_index
    `;
}

function indexesQuery(database: string | null, schemas: string[]): SQL {
  return sql`
      SELECT
        database_name,
        schema_name,
        table_name,
        index_name,
        is_unique,
        expressions,
        sql
      FROM duckdb_indexes()
      WHERE ${buildDatabaseFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
      ORDER BY database_name, schema_name, table_name, index_name
    `;
}

function tableSqlQuery(database: string | null, schemas: string[]): SQL {
  return sql`
      SELECT
        database_name,
        schema_name,
        table_name,
        sql
      FROM duckdb_tables()
      WHERE ${buildDatabaseFilter('database_name', database)}
      AND ${buildSchemaFilter('schema_name', schemas)}
    `;
}

function buildTables(
  tables: DuckDbTableRow[],
  columns: DuckDbColumnRow[],
  constraints: DuckDbConstraintRow[],
  indexes: DuckDbIndexRow[],
  tableSql: DuckDbTableSqlRow[]
): IntrospectedTable[] {
  const byTable: Record<string, IntrospectedTable> = {};
  for (const table of tables) {
    const key = tableKey(
      table.database_name,
      table.schema_name,
      table.table_name
    );
    byTable[key] = {
      database: table.database_name,
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
    const key = tableKey(
      column.database_name,
      column.schema_name,
      column.table_name
    );
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
    const key = tableKey(
      constraint.database_name,
      constraint.schema_name,
      constraint.table_name
    );
    const table = byTable[key];
    if (!table) {
      continue;
    }
    // A table-level CHECK such as CHECK (1 = 1) references no column.
    if (
      !constraint.constraint_column_names?.length &&
      constraint.constraint_type !== 'CHECK'
    ) {
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
    const key = tableKey(
      index.database_name,
      index.schema_name,
      index.table_name
    );
    const table = byTable[key];
    if (!table) {
      continue;
    }
    table.indexes.push(index);
  }

  for (const row of tableSql) {
    const key = tableKey(row.database_name, row.schema_name, row.table_name);
    const table = byTable[key];
    if (!table || !row.sql) {
      continue;
    }
    const generated = parseGeneratedColumns(
      row.sql,
      table.columns.map((column) => column.name)
    );
    if (!generated) {
      continue;
    }
    for (const column of table.columns) {
      column.generatedExpression = generated.get(column.name) ?? null;
    }
  }

  return Object.values(byTable);
}

/**
 * Reads generated columns from a `duckdb_tables().sql` statement. DuckDB
 * reports a generated column's expression as its `column_default` and leaves
 * `information_schema.columns.is_generated` empty, so the CREATE TABLE text is
 * the only place that tells the two apart. Returns undefined when the
 * statement does not list the expected columns in order.
 */
function parseGeneratedColumns(
  createSql: string,
  columnNames: readonly string[]
): Map<string, string | null> | undefined {
  const open = scanTopLevel(createSql, 0, (_, char) => char === '(');
  const close = open < 0 ? -1 : matchingParen(createSql, open);
  if (close < 0) {
    return undefined;
  }

  // Column definitions come first, then table constraints.
  const segments = splitTopLevel(createSql.slice(open + 1, close), ',');
  if (segments.length < columnNames.length) {
    return undefined;
  }

  const generated = new Map<string, string | null>();
  for (const [index, name] of columnNames.entries()) {
    const segment = segments[index]!.trim();
    const identifier = readLeadingIdentifier(segment);
    if (identifier?.name !== name) {
      return undefined;
    }
    const keyword = scanTopLevel(segment, identifier.end, (offset) =>
      GENERATED_KEYWORD.test(segment.slice(offset))
    );
    if (keyword < 0) {
      generated.set(name, null);
      continue;
    }
    const exprOpen = segment.indexOf('(', keyword);
    const exprClose = matchingParen(segment, exprOpen);
    if (exprClose < 0) {
      return undefined;
    }
    generated.set(name, segment.slice(exprOpen + 1, exprClose).trim());
  }
  return generated;
}

const GENERATED_KEYWORD = /^\sGENERATED\s+ALWAYS\s+AS\s*\(/i;

/**
 * Returns the first offset at or after `from` that is outside quotes and
 * parentheses and satisfies `match`, or -1.
 */
function scanTopLevel(
  text: string,
  from: number,
  match: (offset: number, char: string) => boolean
): number {
  let depth = 0;
  for (let offset = from; offset < text.length; offset += 1) {
    const char = text[offset]!;
    if (char === '"' || char === "'") {
      offset = skipQuoted(text, offset);
      continue;
    }
    if (depth === 0 && match(offset, char)) {
      return offset;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
  }
  return -1;
}

/** Returns the offset of the parenthesis closing the one at `open`, or -1. */
function matchingParen(text: string, open: number): number {
  if (text[open] !== '(') {
    return -1;
  }
  return scanTopLevel(text, open + 1, (_, char) => char === ')');
}

/** Returns the offset of the quote closing the one at `open`. */
function skipQuoted(text: string, open: number): number {
  const quote = text[open]!;
  for (let offset = open + 1; offset < text.length; offset += 1) {
    if (text[offset] === quote) {
      if (text[offset + 1] !== quote) {
        return offset;
      }
      offset += 1;
    }
  }
  return text.length;
}

function readLeadingIdentifier(
  text: string
): { name: string; end: number } | undefined {
  if (text.startsWith('"')) {
    const end = skipQuoted(text, 0);
    if (end >= text.length) {
      return undefined;
    }
    return { name: text.slice(1, end).replace(/""/g, '"'), end: end + 1 };
  }
  const match = /^[^\s"(]+/.exec(text);
  return match ? { name: match[0], end: match[0].length } : undefined;
}

interface EmitOptions {
  bigintMode: 'bigint' | 'number';
  useCustomTimeTypes: boolean;
  mapJsonAsDuckDbJson: boolean;
  importBasePath: string;
  currentDatabase: string | null;
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

  if (!catalog.length) {
    return '/* No tables matched the introspection filters. */\nexport {};\n';
  }
  imports.pgCore.add('pgSchema');

  const sorted = [...catalog].sort(
    (a, b) =>
      a.schema.localeCompare(b.schema) ||
      a.name.localeCompare(b.name) ||
      (a.database ?? '').localeCompare(b.database ?? '')
  );

  // Columns and constraints decide the imports, and imported names must be
  // known before table and schema variables are allocated.
  const plans = new Map<string, TablePlan>();
  for (const table of sorted) {
    const columnProperties = buildColumnProperties(table.columns);
    const columnLines = table.columns.map(
      (column) =>
        `  ${columnProperties.get(column.name)!}: ${emitColumn(
          column,
          imports,
          options
        )},`
    );
    const constraints = selectConstraints(table);
    for (const constraint of constraints) {
      imports.pgCore.add(CONSTRAINT_HELPERS[constraint.type]!);
    }
    plans.set(tableKeyOf(table), {
      table,
      columnProperties,
      columnLines,
      constraints,
    });
  }

  const importedNames = new Set([
    ...imports.drizzle,
    ...imports.pgCore,
    ...imports.local,
  ]);
  const schemaIdentifiers = buildSchemaIdentifiers(sorted, importedNames);
  const tableIdentifiers = buildTableIdentifiers(
    sorted,
    importedNames,
    new Set([...importedNames, ...schemaIdentifiers.values()])
  );

  const lines: string[] = [];

  const isOtherDatabase = (table: IntrospectedTable) =>
    table.database !== undefined && table.database !== options.currentDatabase;
  const otherDatabases = [
    ...new Set(sorted.filter(isOtherDatabase).map((table) => table.database!)),
  ];
  if (otherDatabases.length) {
    lines.push(
      ...emitOtherDatabaseHeader(otherDatabases, options.currentDatabase),
      ''
    );
  }

  for (const schema of uniqueSchemas(sorted)) {
    const schemaVar = schemaIdentifiers.get(schema)!;
    lines.push(
      `export const ${schemaVar} = pgSchema(${JSON.stringify(schema)});`,
      ''
    );

    const tables = sorted.filter((table) => table.schema === schema);
    for (const table of tables) {
      const plan = plans.get(tableKeyOf(table))!;
      if (isOtherDatabase(table)) {
        lines.push(
          `/* database: ${commentText(JSON.stringify(table.database))} */`
        );
      }
      lines.push(...emitSkippedDefinitions(table));
      lines.push(
        ...emitTable(
          schemaVar,
          tableIdentifiers.get(tableKeyOf(table))!,
          plan,
          plans,
          tableIdentifiers
        )
      );
      lines.push('');
    }
  }

  const importsBlock = renderImports(imports, options.importBasePath);
  return [importsBlock, ...lines].join('\n').trim() + '\n';
}

function emitOtherDatabaseHeader(
  databases: string[],
  currentDatabase: string | null
): string[] {
  const names = commentText(
    databases.map((name) => JSON.stringify(name)).join(', ')
  );
  const current = currentDatabase
    ? ` (${commentText(JSON.stringify(currentDatabase))})`
    : '';
  return [
    '/*',
    ` * Some tables come from databases other than the current one${current}:`,
    ` * ${names}.`,
    ' * The generated schema does not encode the database (catalog), so queries',
    " * resolve against the connection's current database. Run USE <database> on",
    ' * the connection before querying these tables. Tables from different',
    ' * databases that share a schema name also share one pgSchema() object.',
    ' */',
  ];
}

/** CHECK constraints and indexes are listed as comments, not Drizzle config. */
function emitSkippedDefinitions(table: IntrospectedTable): string[] {
  const lines: string[] = [];
  for (const constraint of table.constraints) {
    if (constraint.type === 'CHECK') {
      lines.push(
        `/* check ${commentText(
          `${JSON.stringify(constraint.name)} (not emitted): ${
            constraint.rawExpression ?? ''
          }`
        )} */`
      );
    }
  }
  for (const index of table.indexes) {
    lines.push(
      `/* index ${commentText(
        `${JSON.stringify(index.index_name)} (not emitted): ${
          index.sql ?? index.expressions ?? ''
        }`
      )} */`
    );
  }
  return lines;
}

/**
 * Keeps catalog text inside a block comment on one line: `*\/` cannot end
 * the comment and line breaks collapse to spaces.
 */
function commentText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\*\//g, '*\\/');
}

interface TablePlan {
  table: IntrospectedTable;
  columnProperties: ReadonlyMap<string, string>;
  columnLines: string[];
  constraints: IntrospectedConstraint[];
}

const CONSTRAINT_HELPERS: Readonly<Record<string, string>> = {
  'PRIMARY KEY': 'primaryKey',
  UNIQUE: 'unique',
  'FOREIGN KEY': 'foreignKey',
};

function selectConstraints(table: IntrospectedTable): IntrospectedConstraint[] {
  if (table.kind === 'view') {
    return [];
  }
  return table.constraints.filter(
    (constraint) =>
      constraint.type in CONSTRAINT_HELPERS &&
      (constraint.type !== 'FOREIGN KEY' || constraint.referencedTable)
  );
}

function emitTable(
  schemaVar: string,
  tableVar: string,
  plan: TablePlan,
  plans: ReadonlyMap<string, TablePlan>,
  tableIdentifiers: ReadonlyMap<string, string>
): string[] {
  if (plan.table.kind === 'view') {
    // .existing() marks the view as defined outside Drizzle, so drizzle-kit
    // does not try to create it and the view cannot be used for inserts.
    return [
      `export const ${tableVar} = ${schemaVar}.view(${JSON.stringify(
        plan.table.name
      )}, {`,
      ...plan.columnLines,
      '}).existing();',
    ];
  }

  const constraintBlock = emitConstraints(plan, plans, tableIdentifiers);

  const tableLines: string[] = [];
  tableLines.push(
    `export const ${tableVar} = ${schemaVar}.table(${JSON.stringify(
      plan.table.name
    )}, {`
  );
  tableLines.push(...plan.columnLines);
  tableLines.push(
    `}${constraintBlock ? ',' : ''}${constraintBlock ? ` ${constraintBlock}` : ''});`
  );

  return tableLines;
}

function emitConstraints(
  plan: TablePlan,
  plans: ReadonlyMap<string, TablePlan>,
  tableIdentifiers: ReadonlyMap<string, string>
): string {
  const { table, constraints } = plan;
  if (!constraints.length) {
    return '';
  }

  const selfKey = tableKeyOf(table);
  const resolveTarget = (constraint: IntrospectedConstraint) => {
    const ref = constraint.referencedTable!;
    const key = tableKey(table.database, ref.schema, ref.name);
    return {
      key,
      identifier: tableIdentifiers.get(key) ?? toIdentifier(ref.name),
      columnProperties: plans.get(key)?.columnProperties,
    };
  };

  // The callback parameter must not shadow a referenced table variable.
  // Self references go through the parameter, which also avoids TS7022.
  const referencedTables = new Set<string>();
  for (const constraint of constraints) {
    if (constraint.type === 'FOREIGN KEY') {
      const target = resolveTarget(constraint);
      if (target.key !== selfKey) {
        referencedTables.add(target.identifier);
      }
    }
  }
  const param = allocateIdentifier('t', referencedTables);
  const ownColumns = (columns: string[]) =>
    columns
      .map((col) =>
        memberAccess(
          param,
          plan.columnProperties.get(col) ?? columnProperty(col)
        )
      )
      .join(', ');

  const entries: string[] = [];
  const usedKeys = new Set<string>();

  for (const constraint of constraints) {
    const key = allocateIdentifier(
      toIdentifier(constraint.name || `${table.name}_constraint`),
      usedKeys
    );
    const name = JSON.stringify(constraint.name);
    if (constraint.type === 'PRIMARY KEY') {
      entries.push(
        `${key}: primaryKey({ columns: [${ownColumns(
          constraint.columns
        )}], name: ${name} })`
      );
    } else if (constraint.type === 'UNIQUE') {
      entries.push(
        `${key}: unique(${name}).on(${ownColumns(constraint.columns)})`
      );
    } else {
      const target = resolveTarget(constraint);
      const targetVar = target.key === selfKey ? param : target.identifier;
      const foreignColumns = constraint
        .referencedTable!.columns.map((col) =>
          memberAccess(
            targetVar,
            target.columnProperties?.get(col) ?? columnProperty(col)
          )
        )
        .join(', ');
      entries.push(
        `${key}: foreignKey({ columns: [${ownColumns(
          constraint.columns
        )}], foreignColumns: [${foreignColumns}], name: ${name} })`
      );
    }
  }

  const lines: string[] = [`(${param}) => ({`];
  for (const entry of entries) {
    lines.push(`  ${entry},`);
  }
  lines.push('})');
  return lines.join('\n');
}

function buildColumnProperties(
  columns: IntrospectedColumn[]
): Map<string, string> {
  const properties = new Map<string, string>();
  const used = new Set<string>();
  for (const column of columns) {
    const preferred = columnProperty(column.name);
    // Quoted keys keep the exact column name, so only camelCased keys can
    // collide (for example user_id and user__id).
    properties.set(
      column.name,
      preferred.startsWith('"')
        ? preferred
        : allocateIdentifier(preferred, used)
    );
  }
  return properties;
}

function memberAccess(object: string, property: string): string {
  return property.startsWith('"')
    ? `${object}[${property}]`
    : `${object}.${property}`;
}

function buildSchemaIdentifiers(
  tables: IntrospectedTable[],
  reserved: ReadonlySet<string>
): Map<string, string> {
  const identifiers = new Map<string, string>();
  const used = new Set(reserved);

  for (const schema of uniqueSchemas(tables)) {
    identifiers.set(
      schema,
      allocateIdentifier(toSchemaIdentifier(schema), used)
    );
  }

  return identifiers;
}

const RESERVED_WORDS = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

function buildTableIdentifiers(
  tables: IntrospectedTable[],
  importedNames: ReadonlySet<string>,
  used: Set<string>
): Map<string, string> {
  const identifiers = new Map<string, string>();
  const baseCounts = new Map<string, number>();
  const schemaTableCounts = new Map<string, number>();
  const schemaTableKey = (table: IntrospectedTable) =>
    JSON.stringify([table.schema, table.name]);

  for (const table of tables) {
    const base = toIdentifier(table.name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
    const key = schemaTableKey(table);
    schemaTableCounts.set(key, (schemaTableCounts.get(key) ?? 0) + 1);
  }

  for (const table of tables) {
    const base = toIdentifier(table.name);
    let preferred = base;
    if ((baseCounts.get(base) ?? 0) > 1) {
      const schemaPrefix = `${toIdentifier(table.schema)}${capitalize(base)}`;
      // The same schema and table name in two databases (allDatabases mode)
      // also needs the database name to stay distinct.
      preferred =
        (schemaTableCounts.get(schemaTableKey(table)) ?? 0) > 1
          ? `${toIdentifier(table.database ?? '')}${capitalize(schemaPrefix)}`
          : schemaPrefix;
    }
    if (RESERVED_WORDS.has(preferred) || importedNames.has(preferred)) {
      preferred = `${preferred}Table`;
    }
    identifiers.set(tableKeyOf(table), allocateIdentifier(preferred, used));
  }

  return identifiers;
}

function allocateIdentifier(preferred: string, used: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;

  while (used.has(candidate)) {
    candidate = `${preferred}${suffix}`;
    suffix += 1;
  }

  used.add(candidate);
  return candidate;
}

function emitColumn(
  column: IntrospectedColumn,
  imports: ImportBuckets,
  options: EmitOptions
): string {
  const mapping = mapDuckDbType(column, imports, options);
  let builder = mapping.builder;

  if (!column.nullable) {
    builder += '.notNull()';
  }

  if (column.generatedExpression) {
    // DuckDB reports the generation expression as column_default too, so it
    // must not become a default. Drizzle leaves generated columns out of
    // inserts and updates.
    imports.drizzle.add('sql');
    return `${builder}.generatedAlwaysAs(${sqlTemplate(
      column.generatedExpression
    )})`;
  }

  const defaultFragment = resolveDefault(column.columnDefault, mapping);
  if (defaultFragment === null) {
    const expression = column.columnDefault!.trim();
    if (column.generatedExpression === null) {
      imports.drizzle.add('sql');
      builder += `.default(${sqlTemplate(expression)})`;
    } else {
      // Without the table definition a generated column cannot be told apart
      // from a default, so the expression stays informational.
      builder += ` /* default: ${escapeBlockComment(expression)} */`;
    }
  } else if (defaultFragment) {
    if (defaultFragment.startsWith('.default(sql`')) {
      imports.drizzle.add('sql');
    }
    builder += defaultFragment;
  }

  return builder;
}

function sqlTemplate(expression: string): string {
  return `sql\`${escapeTemplateLiteral(expression)}\``;
}

type DefaultLiteral = 'number' | 'string' | 'boolean';

interface DefaultTarget {
  /** JS literal types accepted by the builder's `.default()` besides SQL. */
  defaultLiterals?: readonly DefaultLiteral[];
  /** Whether the builder has `.defaultNow()` (pg-core timestamps). */
  defaultNow?: boolean;
}

const LEGACY_DEFAULT_TARGET: DefaultTarget = {
  defaultLiterals: ['number', 'string', 'boolean'],
  defaultNow: true,
};

const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
const STRING_LITERAL = /^'((?:[^']|'')*)'$/s;
const BOOLEAN_CAST = /^CAST\('([tf])' AS BOOLEAN\)$/i;

export function buildDefault(defaultValue: string | null): string {
  return resolveDefault(defaultValue, LEGACY_DEFAULT_TARGET) ?? '';
}

/**
 * Returns the default fragment for a column, an empty string when there is no
 * default, or null when the expression is not recognized.
 */
function resolveDefault(
  defaultValue: string | null,
  target: DefaultTarget
): string | null {
  if (!defaultValue) {
    return '';
  }
  const trimmed = defaultValue.trim();
  if (!trimmed || trimmed.toUpperCase() === 'NULL') {
    return '';
  }

  const literals = target.defaultLiterals ?? [];
  const sqlDefault = `.default(${sqlTemplate(trimmed)})`;

  if (/^nextval\(/i.test(trimmed)) {
    return sqlDefault;
  }
  if (
    /^current_timestamp(?:\(\))?$/i.test(trimmed) ||
    /^now\(\)$/i.test(trimmed)
  ) {
    return target.defaultNow ? `.defaultNow()` : sqlDefault;
  }

  // DuckDB reports DEFAULT true as CAST('t' AS BOOLEAN).
  const booleanCast = BOOLEAN_CAST.exec(trimmed);
  const booleanValue = booleanCast
    ? String(booleanCast[1]!.toLowerCase() === 't')
    : trimmed === 'true' || trimmed === 'false'
      ? trimmed
      : null;
  if (booleanValue) {
    return literals.includes('boolean')
      ? `.default(${booleanValue})`
      : sqlDefault;
  }

  if (NUMBER_LITERAL.test(trimmed)) {
    const isUnsafeInteger =
      /^-?\d+$/.test(trimmed) && !Number.isSafeInteger(Number(trimmed));
    if (literals.includes('number') && !isUnsafeInteger) {
      return `.default(${trimmed})`;
    }
    if (literals.includes('string')) {
      return `.default(${JSON.stringify(trimmed)})`;
    }
    return sqlDefault;
  }

  const stringLiteralMatch = STRING_LITERAL.exec(trimmed);
  if (stringLiteralMatch) {
    if (literals.includes('string')) {
      const value = stringLiteralMatch[1]!.replace(/''/g, "'");
      return `.default(${JSON.stringify(value)})`;
    }
    return sqlDefault;
  }

  return null;
}

function escapeTemplateLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function escapeBlockComment(value: string): string {
  return value.replace(/\*\//g, '*\\/');
}

interface TypeMappingResult extends DefaultTarget {
  builder: string;
}

const NUMBER_DEFAULTS: readonly DefaultLiteral[] = ['number'];
const STRING_DEFAULTS: readonly DefaultLiteral[] = ['string'];

export function normalizeTypeLiteral(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');

  const arrayMatch = /^(.*?)(\[(?:\d+)?\])$/.exec(trimmed);
  if (arrayMatch) {
    const [, base, suffix] = arrayMatch;
    return `${normalizeTypeLiteral(base ?? '')}${suffix ?? ''}`;
  }

  for (const [pattern, replacement] of CANONICAL_TYPE_PREFIXES) {
    const match = pattern.exec(trimmed);
    if (match) {
      return `${replacement}${trimmed.slice(match[0].length)}`;
    }
  }

  const upper = trimmed.toUpperCase();
  if (SIMPLE_TYPE_NAMES.has(upper)) {
    return upper;
  }

  return trimmed;
}

// Nested values use native JS conversion rather than pg-core decoders.
// DuckDB permits null list elements, struct fields and map values.
function nestedValueType(raw: string): string {
  const type = normalizeTypeLiteral(raw);
  const array = /^(.*)\[\d*\]$/.exec(type);
  if (array) return `Array<${nestedValueType(array[1]!)} | null>`;
  if (type.startsWith('STRUCT')) {
    const fields = parseStructFields(
      type.replace(/^STRUCT\s*\(/i, '').replace(/\)$/, '')
    );
    return `{ ${fields.map(({ name, type }) => `${JSON.stringify(name)}: ${nestedValueType(type)} | null`).join('; ')} }`;
  }
  if (type.startsWith('MAP(')) {
    const { keyType, valueType } = parseMapTypes(type);
    return `Array<{ key: ${nestedValueType(keyType ?? 'VARCHAR')}; value: ${nestedValueType(valueType)} | null }>`;
  }
  if (BIGINT_MODE_TYPES.has(type) || type === 'BIGINT' || type === 'INT8')
    return 'bigint';
  if (
    INTEGER_TYPE_ALIASES.has(type) ||
    /^(?:FLOAT|FLOAT4|REAL|DOUBLE|DOUBLE PRECISION)$/.test(type)
  )
    return 'number';
  if (/^(?:DECIMAL|NUMERIC)/.test(type)) return 'number | string';
  if (type === 'BOOLEAN' || type === 'BOOL') return 'boolean';
  if (/^(?:VARCHAR|CHAR|TEXT|STRING|UUID|JSON|ENUM)/.test(type))
    return 'string';
  if (type === 'BLOB' || type === 'BYTEA') return 'Uint8Array';
  if (/^(?:DATE|TIMESTAMP|TIMESTAMPTZ)/.test(type) && type !== 'TIMESTAMP_NS')
    return 'Date';
  if (/^(?:TIME|TIMETZ|TIMESTAMP_NS|INTERVAL)/.test(type)) return 'unknown';
  return 'unknown';
}

function mapDuckDbType(
  column: IntrospectedColumn,
  imports: ImportBuckets,
  options: EmitOptions
): TypeMappingResult {
  const raw = column.dataType.trim();
  const upper = normalizeTypeLiteral(raw);

  if (upper === 'BOOLEAN' || upper === 'BOOL') {
    imports.pgCore.add('boolean');
    return {
      builder: `boolean(${columnName(column.name)})`,
      defaultLiterals: ['boolean'],
    };
  }

  if (INTEGER_TYPE_ALIASES.has(upper)) {
    imports.pgCore.add('integer');
    return {
      builder: `integer(${columnName(column.name)})`,
      defaultLiterals: NUMBER_DEFAULTS,
    };
  }

  if (BIGINT_MODE_TYPES.has(upper)) {
    imports.pgCore.add('bigint');
    return {
      builder: `bigint(${columnName(column.name)}, { mode: 'bigint' })`,
    };
  }

  if (upper === 'BIGINT' || upper === 'INT8') {
    imports.pgCore.add('bigint');
    return {
      builder: `bigint(${columnName(column.name)}, { mode: '${options.bigintMode}' })`,
      defaultLiterals:
        options.bigintMode === 'number' ? NUMBER_DEFAULTS : undefined,
    };
  }

  // Anchored so DECIMAL(p,s)[] falls through to the list mapping below.
  const decimalMatch = /^DECIMAL\((\d+),(\d+)\)$/i.exec(upper);
  const numericMatch = /^NUMERIC\((\d+),(\d+)\)$/i.exec(upper);
  if (decimalMatch || numericMatch) {
    imports.pgCore.add('numeric');
    const [, precision, scale] = decimalMatch ?? numericMatch!;
    return {
      builder: `numeric(${columnName(column.name)}, { precision: ${precision}, scale: ${scale} })`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (
    (upper.startsWith('DECIMAL') || upper.startsWith('NUMERIC')) &&
    !upper.endsWith(']')
  ) {
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
    return {
      builder: `numeric(${columnName(column.name)}${suffix})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  // DuckDB reports REAL and FLOAT4 columns as FLOAT, a 4-byte float.
  if (upper === 'REAL' || upper === 'FLOAT4' || upper === 'FLOAT') {
    imports.pgCore.add('real');
    return {
      builder: `real(${columnName(column.name)})`,
      defaultLiterals: NUMBER_DEFAULTS,
    };
  }

  if (upper === 'DOUBLE' || upper === 'DOUBLE PRECISION') {
    imports.pgCore.add('doublePrecision');
    return {
      builder: `doublePrecision(${columnName(column.name)})`,
      defaultLiterals: NUMBER_DEFAULTS,
    };
  }

  const arrayMatch = /^(.*)\[(\d+)\]$/.exec(upper);
  if (arrayMatch) {
    imports.local.add('duckDbArray');
    const [, base, length] = arrayMatch;
    return {
      builder: `duckDbArray<${nestedValueType(base!)} | null>(${columnName(
        column.name
      )}, ${JSON.stringify(base)}, ${Number(length)})`,
    };
  }

  const listMatch = /^(.*)\[\]$/.exec(upper);
  if (listMatch) {
    imports.local.add('duckDbList');
    const [, base] = listMatch;
    return {
      builder: `duckDbList<${nestedValueType(base!)} | null>(${columnName(
        column.name
      )}, ${JSON.stringify(base)})`,
    };
  }

  if (upper.startsWith('CHAR(') || upper === 'CHAR') {
    imports.pgCore.add('char');
    const length = column.characterLength;
    const lengthPart =
      typeof length === 'number' ? `, { length: ${length} }` : '';
    return {
      builder: `char(${columnName(column.name)}${lengthPart})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper.startsWith('VARCHAR')) {
    imports.pgCore.add('varchar');
    const length = column.characterLength;
    const lengthPart =
      typeof length === 'number' ? `, { length: ${length} }` : '';
    return {
      builder: `varchar(${columnName(column.name)}${lengthPart})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'TEXT' || upper === 'STRING') {
    imports.pgCore.add('text');
    return {
      builder: `text(${columnName(column.name)})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'UUID') {
    imports.pgCore.add('uuid');
    return {
      builder: `uuid(${columnName(column.name)})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'JSON') {
    if (options.mapJsonAsDuckDbJson) {
      imports.local.add('duckDbJson');
      return {
        builder: `duckDbJson(${columnName(column.name)})`,
        defaultLiterals: ['number', 'string', 'boolean'],
      };
    }
    imports.pgCore.add('text');
    return {
      builder: `text(${columnName(column.name)}) /* JSON */`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper.startsWith('ENUM')) {
    imports.pgCore.add('text');
    const enumLiteral = raw.replace(/^ENUM\s*/i, '').trim();
    return {
      builder: `text(${columnName(column.name)}) /* ENUM ${escapeBlockComment(
        enumLiteral
      )} */`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper.startsWith('UNION')) {
    imports.pgCore.add('text');
    const unionLiteral = raw.replace(/^UNION\s*/i, '').trim();
    return {
      builder: `text(${columnName(column.name)}) /* UNION ${escapeBlockComment(
        unionLiteral
      )} */`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'INET') {
    imports.local.add('duckDbInet');
    return {
      builder: `duckDbInet(${columnName(column.name)})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'INTERVAL') {
    imports.local.add('duckDbInterval');
    return {
      builder: `duckDbInterval(${columnName(column.name)})`,
      defaultLiterals: STRING_DEFAULTS,
    };
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
      builder: `duckDbStruct<${nestedValueType(upper)}>(${columnName(
        column.name
      )}, { ${entries.join(', ')} })`,
    };
  }

  if (upper.startsWith('MAP(')) {
    imports.local.add('duckDbMap');
    const { keyType, valueType } = parseMapTypes(upper);
    const mapOptions = keyType
      ? `, { mode: 'object', keyType: ${JSON.stringify(keyType)} }`
      : `, { mode: 'object' }`;
    return {
      builder: `duckDbMap<Record<string, ${nestedValueType(valueType)} | null>>(${columnName(
        column.name
      )}, ${JSON.stringify(valueType)}${mapOptions})`,
    };
  }

  if (upper.startsWith('TIMESTAMP WITH TIME ZONE')) {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbTimestamp');
    } else {
      imports.pgCore.add('timestamp');
    }
    if (options.useCustomTimeTypes) {
      return {
        builder: `duckDbTimestamp(${columnName(column.name)}, { withTimezone: true })`,
        defaultLiterals: STRING_DEFAULTS,
      };
    }
    return {
      builder: `timestamp(${columnName(column.name)}, { withTimezone: true })`,
      defaultNow: true,
    };
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
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper.startsWith('TIMESTAMP')) {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbTimestamp');
      return {
        builder: `duckDbTimestamp(${columnName(column.name)})`,
        defaultLiterals: STRING_DEFAULTS,
      };
    }
    imports.pgCore.add('timestamp');
    return {
      builder: `timestamp(${columnName(column.name)})`,
      defaultNow: true,
    };
  }

  if (upper === 'TIME') {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbTime');
      return {
        builder: `duckDbTime(${columnName(column.name)})`,
        defaultLiterals: STRING_DEFAULTS,
      };
    }
    imports.pgCore.add('time');
    return {
      builder: `time(${columnName(column.name)})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'TIME WITH TIME ZONE' || upper === 'TIMETZ') {
    imports.local.add('duckDbTime');
    return {
      builder: `duckDbTime(${columnName(column.name)}, { withTimezone: true })`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'TIME_NS') {
    imports.local.add('duckDbTime');
    return {
      builder: `duckDbTime(${columnName(
        column.name
      )}, { duckDbType: 'TIME_NS' })`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  if (upper === 'DATE') {
    if (options.useCustomTimeTypes) {
      imports.local.add('duckDbDate');
      return {
        builder: `duckDbDate(${columnName(column.name)})`,
        defaultLiterals: STRING_DEFAULTS,
      };
    }
    imports.pgCore.add('date');
    return {
      builder: `date(${columnName(column.name)})`,
      defaultLiterals: STRING_DEFAULTS,
    };
  }

  // Fallback: keep as text to avoid runtime failures.
  // Unknown types are mapped to text with a comment indicating the original type.
  imports.pgCore.add('text');
  return {
    builder: `text(${columnName(
      column.name
    )}) /* unsupported DuckDB type: ${escapeBlockComment(upper)} */`,
    defaultLiterals: STRING_DEFAULTS,
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
      /^"((?:[^"]|"")+)"\s+(.*)$/i.exec(trimmed) ??
      /^([^\s"]+)\s+(.*)$/i.exec(trimmed);
    if (!match) {
      continue;
    }
    const [, name, type] = match;
    result.push({
      name: name.replace(/""/g, '"'),
      type: normalizeTypeLiteral(type),
    });
  }
  return result;
}

const STRING_MAP_KEY_TYPES = new Set(['VARCHAR', 'TEXT', 'STRING']);

// Schema builders and nested value types share the same MAP grammar and
// defaults. Keep its permissive arity handling for the exported parsers too.
function parseMapTypes(raw: string): {
  keyType: string | undefined;
  valueType: string;
} {
  const inner = raw
    .trim()
    .replace(/^MAP\(/i, '')
    .replace(/\)$/, '');
  const parts = splitTopLevel(inner, ',');
  if (parts.length < 2) {
    return { keyType: undefined, valueType: 'TEXT' };
  }
  const keyType = normalizeTypeLiteral(parts[0] ?? '');
  return {
    keyType: STRING_MAP_KEY_TYPES.has(keyType.toUpperCase())
      ? undefined
      : keyType,
    valueType: normalizeTypeLiteral(parts[1] ?? 'TEXT'),
  };
}

export function parseMapValue(raw: string): string {
  return parseMapTypes(raw).valueType;
}

/** Returns the MAP key type, or undefined when it is a string type. */
export function parseMapKey(raw: string): string | undefined {
  return parseMapTypes(raw).keyType;
}

function tableKey(
  database: string | undefined,
  schema: string,
  table: string
): string {
  return JSON.stringify([database ?? '', schema, table]);
}

function tableKeyOf(table: IntrospectedTable): string {
  return tableKey(table.database, table.schema, table.name);
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

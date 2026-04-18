import type {
  Binary,
  ColumnRefItem,
  ExpressionValue,
} from 'node-sql-parser';

export function isColumnRef(expr: unknown): expr is ColumnRefItem {
  return (
    typeof expr === 'object' &&
    expr !== null &&
    'type' in expr &&
    expr.type === 'column_ref'
  );
}

export function isUnqualifiedColumnRef(
  expr: unknown
): expr is ColumnRefItem {
  return isColumnRef(expr) && (!('table' in expr) || !expr.table);
}

export function isQualifiedColumnRef(expr: unknown): expr is ColumnRefItem {
  return isColumnRef(expr) && 'table' in expr && !!expr.table;
}

export function getColumnName(col: ColumnRefItem): string | null {
  if (typeof col.column === 'string') {
    return col.column;
  }
  if (col.column && 'expr' in col.column && col.column.expr?.value) {
    return String(col.column.expr.value);
  }
  return null;
}

export function isBinaryExpr(
  expr: ExpressionValue | Binary | null | undefined
): expr is Binary {
  return (
    !!expr &&
    typeof expr === 'object' &&
    'type' in expr &&
    (expr as { type?: string }).type === 'binary_expr'
  );
}

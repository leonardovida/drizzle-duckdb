/**
 * AST visitor to rewrite Postgres style generate_series aliases.
 *
 * Postgres lets you reference a generate_series alias as a column:
 *   FROM generate_series(...) AS gs
 *   SELECT gs::date
 *
 * DuckDB treats gs as a table alias, and the column is generate_series.
 * This visitor rewrites unqualified column refs that match a
 * generate_series alias to gs.generate_series.
 */

import type {
  AST,
  ColumnRefItem,
  ExpressionValue,
  From,
  Join,
  Select,
  OrderBy,
  Column,
} from 'node-sql-parser';
import { getColumnName, isBinaryExpr, isColumnRef } from './ast-helpers.ts';

function getGenerateSeriesAliases(from: Select['from']): Set<string> {
  const aliases = new Set<string>();
  if (!from || !Array.isArray(from)) return aliases;

  for (const f of from) {
    if ('expr' in f && f.expr && typeof f.expr === 'object') {
      const exprObj = f.expr as Record<string, unknown>;
      if (exprObj.type === 'function' && 'name' in exprObj) {
        const nameObj = exprObj.name as Record<string, unknown> | undefined;
        const nameParts = nameObj?.name as
          | Array<Record<string, unknown>>
          | undefined;
        const fnName = nameParts?.[0]?.value;
        if (
          typeof fnName === 'string' &&
          fnName.toLowerCase() === 'generate_series'
        ) {
          const alias = typeof f.as === 'string' ? f.as : null;
          if (alias && !alias.includes('(')) {
            aliases.add(alias);
          }
        }
      }
    }
  }

  return aliases;
}

function rewriteAliasColumnRef(col: ColumnRefItem, alias: string): void {
  col.table = alias;
  col.column = { expr: { type: 'default', value: 'generate_series' } };
}

function walkExpression(
  expr: ExpressionValue | null | undefined,
  aliases: Set<string>
): boolean {
  if (!expr || typeof expr !== 'object') return false;

  let transformed = false;
  const exprObj = expr as Record<string, unknown>;

  if (isColumnRef(expr)) {
    if (!('table' in expr) || !expr.table) {
      const colName = getColumnName(expr);
      if (colName && aliases.has(colName)) {
        rewriteAliasColumnRef(expr, colName);
        transformed = true;
      }
    }
    return transformed;
  }

  if (isBinaryExpr(expr)) {
    const binary = expr;
    transformed =
      walkExpression(binary.left as ExpressionValue, aliases) || transformed;
    transformed =
      walkExpression(binary.right as ExpressionValue, aliases) || transformed;
    return transformed;
  }

  if (exprObj.type === 'unary_expr' && exprObj.expr) {
    transformed =
      walkExpression(exprObj.expr as ExpressionValue, aliases) || transformed;
  }

  if (exprObj.type === 'cast' && exprObj.expr) {
    transformed =
      walkExpression(exprObj.expr as ExpressionValue, aliases) || transformed;
  }

  if (exprObj.type === 'case') {
    if (exprObj.expr) {
      transformed =
        walkExpression(exprObj.expr as ExpressionValue, aliases) || transformed;
    }
    if (Array.isArray(exprObj.args)) {
      for (const whenClause of exprObj.args as Array<Record<string, unknown>>) {
        if (whenClause.cond) {
          transformed =
            walkExpression(whenClause.cond as ExpressionValue, aliases) ||
            transformed;
        }
        if (whenClause.result) {
          transformed =
            walkExpression(whenClause.result as ExpressionValue, aliases) ||
            transformed;
        }
      }
    }
  }

  if ('args' in exprObj && exprObj.args) {
    const args = exprObj.args as Record<string, unknown>;
    if (Array.isArray(args.value)) {
      for (const arg of args.value as ExpressionValue[]) {
        transformed = walkExpression(arg, aliases) || transformed;
      }
    } else if (args.expr) {
      transformed =
        walkExpression(args.expr as ExpressionValue, aliases) || transformed;
    }
  }

  if ('over' in exprObj && exprObj.over && typeof exprObj.over === 'object') {
    const over = exprObj.over as Record<string, unknown>;
    if (Array.isArray(over.partition)) {
      for (const part of over.partition as ExpressionValue[]) {
        transformed = walkExpression(part, aliases) || transformed;
      }
    }
    if (Array.isArray(over.orderby)) {
      for (const order of over.orderby as ExpressionValue[]) {
        transformed = walkExpression(order, aliases) || transformed;
      }
    }
  }

  if ('ast' in exprObj && exprObj.ast) {
    const subAst = exprObj.ast as Select;
    if (subAst.type === 'select') {
      transformed = walkSelect(subAst) || transformed;
    }
  }

  if (exprObj.type === 'expr_list' && Array.isArray(exprObj.value)) {
    for (const item of exprObj.value as ExpressionValue[]) {
      transformed = walkExpression(item, aliases) || transformed;
    }
  }

  return transformed;
}

function walkFrom(from: Select['from'], aliases: Set<string>): boolean {
  if (!from || !Array.isArray(from)) return false;

  let transformed = false;

  for (const f of from) {
    if ('join' in f) {
      const join = f as Join;
      transformed =
        walkExpression(join.on as ExpressionValue, aliases) || transformed;
    }
    if ('expr' in f && f.expr && 'ast' in f.expr) {
      transformed = walkSelect(f.expr.ast as Select) || transformed;
    }
  }

  return transformed;
}

function walkOrderBy(
  orderBy: OrderBy[] | null | undefined,
  aliases: Set<string>
): boolean {
  if (!Array.isArray(orderBy)) return false;

  let transformed = false;

  for (const order of orderBy) {
    if (order.expr) {
      transformed =
        walkExpression(order.expr as ExpressionValue, aliases) || transformed;
    }
  }

  return transformed;
}

function walkSelect(select: Select): boolean {
  let transformed = false;
  const aliases = getGenerateSeriesAliases(select.from);

  if (select.with) {
    for (const cte of select.with) {
      const cteSelect = cte.stmt?.ast ?? cte.stmt;
      if (cteSelect && cteSelect.type === 'select') {
        transformed = walkSelect(cteSelect as Select) || transformed;
      }
    }
  }

  transformed = walkFrom(select.from, aliases) || transformed;

  transformed = walkExpression(select.where, aliases) || transformed;

  if (select.having) {
    if (Array.isArray(select.having)) {
      for (const h of select.having) {
        transformed =
          walkExpression(h as ExpressionValue, aliases) || transformed;
      }
    } else {
      transformed =
        walkExpression(select.having as ExpressionValue, aliases) ||
        transformed;
    }
  }

  if (Array.isArray(select.columns)) {
    for (const col of select.columns as Column[]) {
      if ('expr' in col) {
        transformed =
          walkExpression(col.expr as ExpressionValue, aliases) || transformed;
      }
    }
  }

  if (Array.isArray(select.groupby)) {
    for (const g of select.groupby as ExpressionValue[]) {
      transformed = walkExpression(g, aliases) || transformed;
    }
  }

  transformed = walkOrderBy(select.orderby, aliases) || transformed;
  transformed = walkOrderBy(select._orderby, aliases) || transformed;

  if (select._next) {
    transformed = walkSelect(select._next) || transformed;
  }

  return transformed;
}

export function rewriteGenerateSeriesAliases(ast: AST | AST[]): boolean {
  const statements = Array.isArray(ast) ? ast : [ast];
  let transformed = false;

  for (const stmt of statements) {
    if (stmt.type === 'select') {
      transformed = walkSelect(stmt as Select) || transformed;
    }
  }

  return transformed;
}

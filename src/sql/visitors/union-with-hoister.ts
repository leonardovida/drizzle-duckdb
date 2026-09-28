/**
 * AST visitor to hoist WITH clauses out of UNION and other set operations.
 *
 * Drizzle can emit SQL like:
 *   (with a as (...) select ...) union (with b as (...) select ...)
 *
 * DuckDB 1.4.x has an internal binder bug for this pattern.
 * We merge per arm CTEs into a single top level WITH when names do not collide.
 *
 * Hoisting is skipped when it would change the query:
 * - an arm has ORDER BY, LIMIT or OFFSET, since the merged form drops the
 *   parentheses that scope those clauses to the arm
 * - a CTE name matches a table referenced by another arm, since the hoisted
 *   CTE would shadow that table
 */

import type { AST, Select, From } from 'node-sql-parser';

function getCteName(cte: { name?: unknown }): string | null {
  const nameObj = cte.name as Record<string, unknown> | undefined;
  if (!nameObj) return null;
  const value = nameObj.value;
  if (typeof value === 'string') return value;
  return null;
}

function hasArmModifiers(arm: Select): boolean {
  const { orderby, limit } = arm as Select & {
    limit?: { value?: unknown[] } | null;
  };
  return (
    (Array.isArray(orderby) && orderby.length > 0) ||
    (Array.isArray(limit?.value) && limit.value.length > 0)
  );
}

/** Collect table names referenced in FROM and JOIN lists anywhere in an arm. */
function collectTableRefs(node: unknown, refs: Set<string>, root = true): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTableRefs(item, refs, false);
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    // The next arm of the set operation is collected separately.
    if (root && key === '_next') continue;
    if (key === 'from' && Array.isArray(value)) {
      for (const from of value) {
        const table = (from as { table?: unknown } | null)?.table;
        if (typeof table === 'string') refs.add(table.toLowerCase());
      }
    }
    collectTableRefs(value, refs, false);
  }
}

function hoistWithInSelect(select: Select): boolean {
  if (!select.set_op || !select._next) return false;

  const arms: Select[] = [];
  let current: Select | null = select;
  while (current && current.type === 'select') {
    arms.push(current);
    current = current._next as Select | null;
  }

  const mergedWith: NonNullable<Select['with']> = [];
  const seen = new Set<string>();
  let hasWithBeyondFirst = false;

  for (const arm of arms) {
    if (arm.with && arm.with.length > 0) {
      if (arm !== arms[0]) {
        hasWithBeyondFirst = true;
      }
      for (const cte of arm.with) {
        const cteName = getCteName(cte);
        if (!cteName) return false;
        if (seen.has(cteName.toLowerCase())) {
          return false;
        }
        seen.add(cteName.toLowerCase());
        mergedWith.push(cte);
      }
    }
  }

  if (!hasWithBeyondFirst) return false;

  if (arms.some(hasArmModifiers)) return false;

  for (const arm of arms) {
    const ownCtes = new Set(
      (arm.with ?? []).map((cte) => getCteName(cte)?.toLowerCase())
    );
    const refs = new Set<string>();
    collectTableRefs(arm, refs);
    for (const name of seen) {
      if (!ownCtes.has(name) && refs.has(name)) return false;
    }
  }

  arms[0].with = mergedWith;
  if ('parentheses_symbol' in arms[0]) {
    (arms[0] as Select & { parentheses_symbol?: boolean }).parentheses_symbol =
      false;
  }
  for (let i = 1; i < arms.length; i++) {
    arms[i].with = null;
  }

  return true;
}

function walkSelect(select: Select): boolean {
  let transformed = false;

  if (select.with) {
    for (const cte of select.with) {
      const cteSelect = cte.stmt?.ast ?? cte.stmt;
      if (cteSelect && cteSelect.type === 'select') {
        transformed = walkSelect(cteSelect as Select) || transformed;
      }
    }
  }

  if (Array.isArray(select.from)) {
    for (const from of select.from as From[]) {
      if ('expr' in from && from.expr && 'ast' in from.expr) {
        transformed = walkSelect(from.expr.ast as Select) || transformed;
      }
    }
  }

  transformed = hoistWithInSelect(select) || transformed;

  if (select._next) {
    transformed = walkSelect(select._next) || transformed;
  }

  return transformed;
}

export function hoistUnionWith(ast: AST | AST[]): boolean {
  const statements = Array.isArray(ast) ? ast : [ast];
  let transformed = false;

  for (const stmt of statements) {
    if (stmt.type === 'select') {
      transformed = walkSelect(stmt as Select) || transformed;
    }
  }

  return transformed;
}

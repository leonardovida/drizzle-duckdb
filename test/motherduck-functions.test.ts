import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { mdAccessTokens, mdListDives } from '../src/motherduck.ts';
import { DuckDBDialect } from '../src/dialect.ts';

test('MotherDuck table function helpers emit callable SQL', () => {
  const dialect = new DuckDBDialect();

  const tokens = dialect.sqlToQuery(sql`
    select token_name, token_type, created_ts, expire_at
    from ${mdAccessTokens()}
    order by token_name
  `);

  const dives = dialect.sqlToQuery(sql`
    select id, required_resources
    from ${mdListDives()}
    where len(required_resources) > 0
  `);

  expect(tokens.sql).toContain('from md_access_tokens()');
  expect(tokens.params).toEqual([]);
  expect(dives.sql).toContain('from md_list_dives()');
  expect(dives.sql).toContain('required_resources');
  expect(dives.params).toEqual([]);
});

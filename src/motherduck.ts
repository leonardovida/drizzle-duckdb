import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql/sql';

export interface MotherDuckAccessTokenRow {
  token_name: string;
  token_type: string;
  created_ts: Date | string;
  expire_at: Date | string | null;
}

export interface MotherDuckRequiredResource {
  name: string | null;
  alias: string | null;
  url: string | null;
  id: string | null;
  resource_type: string | null;
}

export function mdAccessTokens(): SQL {
  return sql`md_access_tokens()`;
}

export function mdListDives(): SQL {
  return sql`md_list_dives()`;
}

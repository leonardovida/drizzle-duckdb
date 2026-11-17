import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// From drizzle codebase. Also lol @ the comment

// shut up eslint you cannot possibly comprehend what's happening here
export function Expect<T extends true>(_value?: T) {
  void _value;
}

export type Equal<X, Y extends X> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

export function toLocalDate(date: Date) {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  localTime.setUTCHours(0);
  return localTime;
}

export const randomString = () =>
  Array.from(
    { length: 10 },
    () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
  ).join('');

export interface MigrationFixture {
  /** Name after the timestamp, for example 'init'. */
  tag: string;
  /** Creation time in milliseconds. drizzle-orm 1.0 keeps whole seconds. */
  when: number;
  sql: string;
}

/**
 * Write migrations in the drizzle-kit 1.0 folder layout that drizzle-orm 1.0
 * reads: one `<YYYYMMDDHHMMSS>_<tag>/migration.sql` folder per migration.
 */
export function writeMigrationFolders(
  folder: string,
  migrations: readonly MigrationFixture[]
): void {
  for (const { tag, when, sql } of migrations) {
    const stamp = new Date(when)
      .toISOString()
      .replace(/\.\d{3}Z$/, '')
      .replace(/\D/g, '');
    const dir = join(folder, `${stamp}_${tag}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'migration.sql'), sql);
  }
}

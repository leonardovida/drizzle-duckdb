---
layout: default
title: MotherDuck Concurrent Writers
parent: Examples
nav_order: 7
---

# MotherDuck Concurrent Writers Example

Several parts of an application write to one MotherDuck database at the same time. Each MotherDuck database has one writer, the read/write Duckling of the account that owns it. Every connection made with that account's read/write token runs there, under DuckDB's optimistic concurrency control. Independent pipelines that should not share a Duckling write to [separate databases](https://motherduck.com/docs/concepts/scaling-patterns/).

**Source**: [example/motherduck-concurrent-writers.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/motherduck-concurrent-writers.ts)

## Prerequisites

- `MOTHERDUCK_TOKEN`: a read/write token
- `MOTHERDUCK_EXAMPLE_DB` (optional): the database to use, `drizzle_examples` by default. The script replaces only the tables that start with `writers_`.

## Run the Example

```bash
export MOTHERDUCK_TOKEN=your_read_write_token
bun example/motherduck-concurrent-writers.ts
```

## What It Demonstrates

- **Batched ingestion**: eight producers push 16,000 events through a batcher that writes one insert per 2,000 rows. Each batch is sent as a single JSON parameter, which binds several times faster than a multi-row `VALUES` insert. Single-row inserts are shown for comparison, because each one is a network round trip.
- **Concurrent appends**: four transactions on pooled connections append to the same table at once. Appends touch different rows and commit without conflicts.
- **Conflicting updates**: 24 concurrent transactions reserve stock on two rows. DuckDB rejects the losing transaction of each conflict, and a retry helper with jittered backoff runs it again, so no reservation is lost.
- **Idempotent upserts from two services**: two DuckDB instances that share the writer account upsert the same keys with `onConflictDoUpdate`. When both insert a new key at once, the later commit fails with a duplicate key. The retry finds the row and takes the update path.

## Key Snippet

```typescript
function isConflict(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (/conflict|duplicate key/i.test(e.message)) return true;
  }
  return false;
}

await withConflictRetry(() =>
  db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(inventory)
      .where(eq(inventory.sku, sku));
    await tx
      .update(inventory)
      .set({ reserved: sql`${inventory.reserved} + 1` })
      .where(eq(inventory.sku, sku));
  })
);
```

## Notes

- Read scaling tokens cannot write. Writers always use a read/write token.
- For DuckLake databases on MotherDuck, the owning account can run concurrent appends. For concurrent updates or deletes on one table, only the first commit succeeds, and concurrent DDL is not allowed. See [DuckLake on MotherDuck](https://motherduck.com/docs/integrations/file-formats/ducklake/).

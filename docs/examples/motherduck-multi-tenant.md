---
layout: default
title: MotherDuck Multi-Tenant
parent: Examples
nav_order: 8
---

# MotherDuck Multi-Tenant Example

A SaaS backend keeps each customer's data in its own MotherDuck database and routes every request to the right tenant.

**Source**: [example/motherduck-multi-tenant.ts](https://github.com/leonardovida/drizzle-duckdb/blob/main/example/motherduck-multi-tenant.ts)

## Prerequisites

- `MOTHERDUCK_TOKEN`: a read/write token for the admin account
- `MOTHERDUCK_TENANT_TOKENS` (optional): JSON such as `{"acme":"token","globex":"token","initech":"token"}` with a token per tenant service account
- `KEEP_TENANT_DATABASES=1` (optional): keeps the tenant databases. By default the script drops the `drizzle_examples_tenant_*` databases it created.

## Run the Example

```bash
export MOTHERDUCK_TOKEN=your_read_write_token
bun example/motherduck-multi-tenant.ts
```

## What It Demonstrates

- One database per tenant, each migrated with the same Drizzle migrations from `example/migrations/tenant` through `migrate()`
- A tenant registry that opens a tenant's DuckDB instance on first use and closes the least recently used idle tenant. Requests hold a lease, so a tenant is never closed while a request is using it.
- Tenant connections with `attach_mode=single`, which attaches only that tenant's database, and `saas_mode=true`, which blocks access to the server's local files
- A per-account usage limit enforced inside a transaction
- A cross-tenant report built from the admin connection

## Key Snippet

```typescript
const instance = await DuckDBInstance.create(
  `md:drizzle_examples_tenant_${tenant}?attach_mode=single&saas_mode=true`,
  {
    motherduck_token: tokenFor(tenant),
    motherduck_session_name: `tenant-${tenant}`,
  }
);
const db = drizzle({
  client: createDuckDBConnectionPool(instance, { size: 2 }),
});
```

## Notes

- `attach_mode=single` limits what a connection attaches, but every database in one account is reachable with that account's token. For strict isolation, MotherDuck recommends [one service account per customer](https://motherduck.com/docs/key-tasks/customer-facing-analytics/3-tier-cfa-guide/). Each service account has its own Duckling and its own read scaling pool, so one tenant's load does not slow another.
- With per-tenant service accounts, internal reporting reads tenant data through [shares](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/create-share/) instead of querying the tenant databases directly. The example skips its cross-tenant report in that case.
- Pass each tenant's token in the instance options rather than through a process-wide environment variable, so concurrent requests for different tenants cannot pick up the wrong token.

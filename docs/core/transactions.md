---
layout: default
title: Transactions
parent: Core Concepts
nav_order: 4
---

# Transactions

Execute multiple operations atomically with transaction support.

## Basic Usage

```typescript
await db.transaction(async (tx) => {
  // All operations in this block are atomic
  await tx.insert(users).values({ name: 'Alice', email: 'alice@example.com' });
  await tx
    .update(accounts)
    .set({ balance: sql`balance - 100` })
    .where(eq(accounts.userId, 1));
  await tx
    .update(accounts)
    .set({ balance: sql`balance + 100` })
    .where(eq(accounts.userId, 2));
});
```

If any operation fails, all changes are rolled back.

## Pooling and Transactions

When you create a database with connection pooling (`drizzle(':memory:', { pool: { size: 4 } })` or the async connection-string form), transactions **pin a single pooled connection** for their entire lifetime. `BEGIN`, all queries in the callback, and `COMMIT`/`ROLLBACK` run on that one connection to keep the transaction atomic. No extra configuration is required. Non-transactional queries still use the pool.

## With Return Value

```typescript
const newUser = await db.transaction(async (tx) => {
  const [user] = await tx
    .insert(users)
    .values({ name: 'Alice', email: 'alice@example.com' })
    .returning();

  await tx.insert(profiles).values({ userId: user.id, bio: 'Hello!' });

  return user;
});

console.log(newUser.id);
```

## Manual Rollback

```typescript
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });

  const balance = await tx
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.userId, 1));

  if (balance[0].balance < 100) {
    tx.rollback(); // Aborts the entire transaction
    return;
  }

  await tx
    .update(accounts)
    .set({ balance: sql`balance - 100` })
    .where(eq(accounts.userId, 1));
});
```

## Error Handling

```typescript
try {
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ name: 'Alice', email: 'alice@example.com' });
    await tx.insert(users).values({ name: 'Bob', email: 'alice@example.com' }); // Duplicate email
  });
} catch (error) {
  // Transaction rolled back automatically
  console.error('Transaction failed:', error.message);
}
```

### A Failed Statement Aborts the Transaction

DuckDB aborts the whole transaction when any statement fails. Catching the error does not keep earlier writes. Validate before writing, or run the risky write in its own `db.transaction()`.

If you catch the statement error inside the callback and let the callback finish, `db.transaction()` still rejects. It rolls back and throws this error, with the statement error as `cause`:

```
DuckDB aborted the transaction because a statement inside it failed. No changes were committed. Rethrow the statement error, or catch it outside db.transaction(), instead of continuing the transaction.
```

```typescript
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: 1, name: 'Alice' });
    try {
      await tx.insert(users).values({ id: 1, name: 'Alice again' }); // duplicate key
    } catch {
      // Catching here does not save the first insert
    }
  });
} catch (error) {
  console.error(error.message); // DuckDB aborted the transaction ...
  console.error(error.cause); // the constraint error
}
```

Parser errors and catalog errors, such as a typo in SQL or a missing table, do not abort a DuckDB transaction. The transaction can continue after you catch them.

If `COMMIT` itself fails, `db.transaction()` rejects with the commit error.

## Transaction Config (Deprecated)

{: .warning }

> **Deprecated**
>
> DuckDB has no `SET TRANSACTION` statement. The `config` argument of `db.transaction(fn, config)`, with options such as `isolationLevel`, `accessMode` and `deferrable`, is ignored. The first call that passes it prints a one-time `console.warn`: `Transaction config is not supported by DuckDB and is ignored. Passing it will throw in the next major version.` `DuckDBTransaction.setTransaction()` and `getTransactionConfigSQL()` are deprecated as well. Remove the config argument.

## Important Limitation: No Savepoints

{: .warning }

> **DuckDB Limitation**
>
> DuckDB 1.4.x and 1.5.x do **not** support `SAVEPOINT`. The first nested `tx.transaction()` call tries a savepoint once per dialect instance. DuckDB rejects it with a parser error, which does not abort the outer transaction. From then on, nested calls run inside the outer transaction.

### What Happens with Nested Transactions

- The nested callback's writes belong to the outer transaction. They commit or roll back with it.
- If the nested callback throws, including through `innerTx.rollback()`, the outer transaction is marked for rollback. Catching the error in the outer callback does not help: `db.transaction()` rolls back and rejects with Drizzle's `TransactionRollbackError`.

```typescript
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });

  // This "nested" transaction actually reuses the outer transaction
  await tx.transaction(async (innerTx) => {
    await innerTx.insert(users).values({ name: 'Bob' });

    // This rollback aborts THE ENTIRE TRANSACTION
    innerTx.rollback();
  });
});

// Result: Neither Alice nor Bob are inserted!
```

### Workarounds

**Option 1: Avoid nested transactions**

```typescript
// Don't do this
await db.transaction(async (tx) => {
  await tx.transaction(async (innerTx) => { ... });
});

// Do this instead
await db.transaction(async (tx) => {
  // Keep everything at one level
  await tx.insert(users).values({ name: 'Alice' });
  await tx.insert(users).values({ name: 'Bob' });
});
```

**Option 2: Use separate transactions**

Run the risky write in its own top-level `db.transaction()`:

```typescript
// First transaction
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });
});

// Second transaction (independent)
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: 'Bob' });
  });
} catch (error) {
  // Only Bob's transaction failed, Alice is committed
}
```

## Transaction Patterns

### All-or-Nothing

```typescript
async function transferFunds(fromId: number, toId: number, amount: number) {
  await db.transaction(async (tx) => {
    // Deduct from source
    const [from] = await tx
      .update(accounts)
      .set({ balance: sql`balance - ${amount}` })
      .where(eq(accounts.id, fromId))
      .returning();

    if (from.balance < 0) {
      tx.rollback();
      throw new Error('Insufficient funds');
    }

    // Add to destination
    await tx
      .update(accounts)
      .set({ balance: sql`balance + ${amount}` })
      .where(eq(accounts.id, toId));
  });
}
```

### Idempotent Operations

```typescript
async function ensureUserExists(email: string, name: string) {
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(users)
      .where(eq(users.email, email));

    if (existing.length > 0) {
      return existing[0];
    }

    const [newUser] = await tx
      .insert(users)
      .values({ email, name })
      .returning();

    return newUser;
  });
}
```

### Batch with Validation

```typescript
async function createOrderWithItems(
  userId: number,
  items: Array<{ productId: number; quantity: number }>
) {
  return await db.transaction(async (tx) => {
    // Validate all products exist and have stock
    for (const item of items) {
      const [product] = await tx
        .select()
        .from(products)
        .where(eq(products.id, item.productId));

      if (!product) {
        tx.rollback();
        throw new Error(`Product ${item.productId} not found`);
      }

      if (product.stock < item.quantity) {
        tx.rollback();
        throw new Error(`Insufficient stock for ${product.name}`);
      }
    }

    // Create order
    const [order] = await tx
      .insert(orders)
      .values({ userId, status: 'pending' })
      .returning();

    // Create order items and update stock
    for (const item of items) {
      await tx.insert(orderItems).values({
        orderId: order.id,
        productId: item.productId,
        quantity: item.quantity,
      });

      await tx
        .update(products)
        .set({ stock: sql`stock - ${item.quantity}` })
        .where(eq(products.id, item.productId));
    }

    return order;
  });
}
```

## See Also

- [DuckDBDatabase]({{ '/api/database' | relative_url }}): transaction API
- [Limitations]({{ '/reference/limitations' | relative_url }}): savepoint limitation details
- [Queries]({{ '/core/queries' | relative_url }}): query patterns

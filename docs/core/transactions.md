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

## Pooling & Transactions

When you create a database with connection pooling (`drizzle(':memory:', { pool: { size: 4 } })` or the async connection-string form), transactions automatically **pin a single pooled connection** for their entire lifetime. `BEGIN`, all queries in the callback, and `COMMIT`/`ROLLBACK` run on that one connection to keep the transaction atomic. No extra configuration is required; pooling is still used for non-transactional queries.

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

## Important Limitation: No Savepoints

{: .warning }

> **DuckDB Limitation**
>
> DuckDB 1.4.x and 1.5.x currently do **not** support `SAVEPOINT`. The driver will try once per dialect instance. After the syntax error, it marks savepoints unsupported and nested calls reuse the outer transaction.

### What Happens with Nested Transactions

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

**Option 2: Handle errors without rolling back**

```typescript
await db.transaction(async (tx) => {
  await tx.insert(users).values({ name: 'Alice' });

  try {
    // This might fail
    await tx.insert(users).values({ name: 'Bob', email: duplicateEmail });
  } catch (error) {
    // Log but don't rollback - Alice is still inserted
    console.error('Failed to insert Bob:', error.message);
  }
});
```

**Option 3: Use separate transactions**

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

- [DuckDBDatabase]({{ '/api/database' | relative_url }}) - Transaction API
- [Limitations]({{ '/reference/limitations' | relative_url }}) - Savepoint limitation details
- [Queries]({{ '/core/queries' | relative_url }}) - Query patterns

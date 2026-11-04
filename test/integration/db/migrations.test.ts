import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase, expectAppendOnly, insertLedgerEntry, insertTransaction, insertWallet, type TestDatabase } from "./support";

const TABLES = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];
const INDEXES = [
  "outbox_messages_unpublished_due",
  "wager_transactions_one_opening_per_wallet",
  "wager_transactions_one_reversal_per_reference",
  "wager_transactions_pending_reference_due",
  "wallet_ledger_entries_wallet_cursor",
];

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(() => db.drop());

async function publicTables(): Promise<string[]> {
  const rows = await db.sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'
    ORDER BY tablename
  `;
  return rows.map((row: { tablename: string }) => row.tablename);
}

async function publicIndexes(): Promise<string[]> {
  const rows = await db.sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = ANY(${db.sql.array(INDEXES)})
    ORDER BY indexname
  `;
  return rows.map((row: { indexname: string }) => row.indexname);
}

async function ledgerFunctionExists(): Promise<boolean> {
  const rows = await db.sql`SELECT 1 FROM pg_proc WHERE proname = 'wallet_ledger_entries_reject_change'`;
  return rows.length > 0;
}

describe("initial migration", () => {
  // Order matters: this walks the same database through up, down and up again.
  test("up creates tables, indexes and the ledger function", async () => {
    await db.orm.migrator.up();
    expect(await publicTables()).toEqual(TABLES);
    expect(await publicIndexes()).toEqual(INDEXES);
    expect(await ledgerFunctionExists()).toBe(true);
  });

  test("up again has nothing to apply", async () => {
    expect(await db.orm.migrator.up()).toEqual([]);
  });

  test("down reverts everything, even with ledger rows present", async () => {
    const wallet = await insertWallet(db.sql);
    const transaction = await insertTransaction(db.sql, wallet);
    await insertLedgerEntry(db.sql, wallet, transaction);

    await db.orm.migrator.down();

    expect(await publicTables()).toEqual([]);
    expect(await publicIndexes()).toEqual([]);
    expect(await ledgerFunctionExists()).toBe(false);
  });

  test("up after down restores a working schema", async () => {
    await db.orm.migrator.up();
    expect(await publicTables()).toEqual(TABLES);

    const wallet = await insertWallet(db.sql);
    const transaction = await insertTransaction(db.sql, wallet);
    await insertLedgerEntry(db.sql, wallet, transaction);
    await expectAppendOnly(() => db.sql`DELETE FROM wallet_ledger_entries`, "DELETE");
  });
});

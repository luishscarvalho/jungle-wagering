import { expect } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { randomUUIDv7, SQL } from "bun";
import { createOrmConfig } from "../../../src/infrastructure/db/mikro-orm.config";

export type Row = Record<string, unknown>;

export interface TestDatabase {
  sql: SQL;
  orm: MikroORM;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database on the compose Postgres. A database per run keeps
 * the dev data untouched and is the only clean reset available, since the ledger
 * trigger blocks DELETE and TRUNCATE by design.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("DATABASE_URL is required. Is .env present and the compose stack up?");

  const name = `wagering_test_${randomUUIDv7().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const orm = await MikroORM.init(createOrmConfig(url.toString()));
  const sql = new SQL(url.toString());

  return {
    sql,
    orm,
    async drop() {
      await sql.close();
      await orm.close(true);
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export const SQLSTATE = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  restrictViolation: "23001",
} as const;

/** Asserts the failure came from this exact constraint, not from an unrelated one. */
export async function expectViolation(
  statement: () => PromiseLike<unknown>,
  sqlstate: string,
  constraint: string,
): Promise<void> {
  const error = await capture(statement);
  expect(error).toMatchObject({ errno: sqlstate, constraint });
}

export async function expectAppendOnly(statement: () => PromiseLike<unknown>, operation: string): Promise<void> {
  const error = await capture(statement);
  expect(error).toMatchObject({ errno: SQLSTATE.restrictViolation });
  expect((error as Error).message).toContain(`append-only: ${operation}`);
}

async function capture(statement: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await statement();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the statement to be rejected, but it succeeded");
}

async function insert(sql: SQL, table: string, row: Row): Promise<Row> {
  const [inserted] = await sql`INSERT INTO ${sql(table)} ${sql(row)} RETURNING *`;
  return inserted as Row;
}

export function walletRow(overrides: Row = {}): Row {
  const now = new Date();
  return {
    id: randomUUIDv7(),
    player_id: randomUUIDv7(),
    currency: "BRL",
    balance: "100.00",
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function insertWallet(sql: SQL, overrides: Row = {}): Promise<Row> {
  return insert(sql, "wallets", walletRow(overrides));
}

/** A valid row for the given wallet. Status-dependent columns follow status by default. */
export function transactionRow(wallet: Row, overrides: Row = {}): Row {
  const externalId = randomUUIDv7();
  const status = overrides.status ?? "PROCESSED";
  return {
    id: randomUUIDv7(),
    provider_id: "provider-a",
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: "hash",
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "25.00",
    currency: wallet.currency,
    status,
    processed_at: status === "PROCESSED" ? new Date() : null,
    failure_code: status === "REJECTED" || status === "FAILED" ? "SOME_FAILURE" : null,
    balance_after: status === "PROCESSED" || status === "REJECTED" ? "75.00" : null,
    next_attempt_at: status === "PENDING_REFERENCE" ? new Date() : null,
    created_at: new Date(),
    ...overrides,
  };
}

export function insertTransaction(sql: SQL, wallet: Row, overrides: Row = {}): Promise<Row> {
  return insert(sql, "wager_transactions", transactionRow(wallet, overrides));
}

export function insertReversal(sql: SQL, wallet: Row, reference: Row, overrides: Row = {}): Promise<Row> {
  return insertTransaction(sql, wallet, {
    kind: "REFUND",
    reference_external_transaction_id: reference.external_transaction_id,
    reference_transaction_id: reference.id,
    ...overrides,
  });
}

export function ledgerRow(wallet: Row, transaction: Row, overrides: Row = {}): Row {
  return {
    id: randomUUIDv7(),
    wallet_id: wallet.id,
    transaction_id: transaction.id,
    direction: "DEBIT",
    amount: "25.00",
    balance_before: "100.00",
    balance_after: "75.00",
    created_at: new Date(),
    ...overrides,
  };
}

export function insertLedgerEntry(sql: SQL, wallet: Row, transaction: Row, overrides: Row = {}): Promise<Row> {
  return insert(sql, "wallet_ledger_entries", ledgerRow(wallet, transaction, overrides));
}

export function insertInboxMessage(sql: SQL, overrides: Row = {}): Promise<Row> {
  return insert(sql, "inbox_messages", {
    consumer_name: "wager-consumer",
    message_id: randomUUIDv7(),
    payload_hash: "hash",
    received_at: new Date(),
    ...overrides,
  });
}

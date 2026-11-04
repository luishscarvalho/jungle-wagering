import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL } from "bun";
import {
  createTestDatabase,
  expectAppendOnly,
  expectViolation,
  insertInboxMessage,
  insertLedgerEntry,
  insertReversal,
  insertTransaction,
  insertWallet,
  SQLSTATE,
  type TestDatabase,
} from "./support";

let db: TestDatabase;
let sql: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
});

afterAll(() => db.drop());

describe("wallets", () => {
  test("accepts a valid wallet", async () => {
    const wallet = await insertWallet(sql, { balance: "99999999999999999.99" });
    expect(wallet.balance).toBe("99999999999999999.99");
  });

  test("rejects a negative balance on insert", async () => {
    await expectViolation(
      () => insertWallet(sql, { balance: "-0.01" }),
      SQLSTATE.checkViolation,
      "wallets_balance_non_negative",
    );
  });

  test("rejects an update that would make the balance negative", async () => {
    const wallet = await insertWallet(sql, { balance: "10.00" });
    await expectViolation(
      () => sql`UPDATE wallets SET balance = balance - 10.01 WHERE id = ${wallet.id}`,
      SQLSTATE.checkViolation,
      "wallets_balance_non_negative",
    );
  });

  test("rejects a second wallet for the same player and currency", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertWallet(sql, { player_id: wallet.player_id }),
      SQLSTATE.uniqueViolation,
      "wallets_player_currency_unique",
    );
  });

  test("allows the same player to have a wallet in another currency", async () => {
    const wallet = await insertWallet(sql);
    await insertWallet(sql, { player_id: wallet.player_id, currency: "USD" });
  });

  test.each(["brl", "BR", "B1L"])("rejects currency format %s", async (currency) => {
    await expectViolation(() => insertWallet(sql, { currency }), SQLSTATE.checkViolation, "wallets_currency_format");
  });

  test("rejects version below 1", async () => {
    await expectViolation(() => insertWallet(sql, { version: 0 }), SQLSTATE.checkViolation, "wallets_version_positive");
  });
});

describe("wager_transactions", () => {
  test("rejects a duplicate idempotency key", async () => {
    const wallet = await insertWallet(sql);
    const first = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertTransaction(sql, wallet, { idempotency_key: first.idempotency_key }),
      SQLSTATE.uniqueViolation,
      "wager_transactions_idempotency_key_unique",
    );
  });

  test("rejects a duplicate provider and external id", async () => {
    const wallet = await insertWallet(sql);
    const first = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertTransaction(sql, wallet, { external_transaction_id: first.external_transaction_id }),
      SQLSTATE.uniqueViolation,
      "wager_transactions_provider_external_unique",
    );
  });

  test("allows the same external id from another provider", async () => {
    const wallet = await insertWallet(sql);
    const first = await insertTransaction(sql, wallet);
    await insertTransaction(sql, wallet, {
      provider_id: "provider-b",
      external_transaction_id: first.external_transaction_id,
    });
  });

  test("rejects a currency different from the wallet's", async () => {
    const wallet = await insertWallet(sql, { currency: "BRL" });
    await expectViolation(
      () => insertTransaction(sql, wallet, { currency: "USD" }),
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_wallet_player_currency_fk",
    );
  });

  test("rejects an unknown wallet", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { wallet_id: randomUUIDv7() }),
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_wallet_player_currency_fk",
    );
  });

  test("rejects a player different from the wallet's, even one with a wallet of their own", async () => {
    const wallet = await insertWallet(sql);
    const otherWallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { player_id: otherWallet.player_id }),
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_wallet_player_currency_fk",
    );
  });

  test("rejects an unknown reference", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { reference_transaction_id: randomUUIDv7() }),
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_reference_fk",
    );
  });

  test("rejects a reference from another wallet", async () => {
    const wallet = await insertWallet(sql);
    const otherWallet = await insertWallet(sql);
    const otherBet = await insertTransaction(sql, otherWallet);
    await expectViolation(
      () => insertReversal(sql, wallet, otherBet),
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_reference_fk",
    );
  });

  test("rejects a reference from another round", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet, { round_id: "round-1" });
    await expectViolation(
      () => insertReversal(sql, wallet, bet, { round_id: "round-2" }),
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_reference_fk",
    );
  });

  test("rejects resolving a pending reversal to a reference from another round", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet, { round_id: "round-1" });
    const pending = await insertTransaction(sql, wallet, {
      kind: "ROLLBACK",
      status: "PENDING_REFERENCE",
      round_id: "round-2",
      reference_external_transaction_id: bet.external_transaction_id,
    });
    await expectViolation(
      () => sql`UPDATE wager_transactions SET reference_transaction_id = ${bet.id} WHERE id = ${pending.id}`,
      SQLSTATE.foreignKeyViolation,
      "wager_transactions_reference_fk",
    );
  });

  test("allows a WIN to reference a BET of the same wallet and round", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    await insertTransaction(sql, wallet, {
      kind: "WIN",
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    });
  });

  test("keeps a reversal rejected for a foreign reference auditable, with the reference unresolved", async () => {
    const wallet = await insertWallet(sql);
    const otherWallet = await insertWallet(sql);
    const otherBet = await insertTransaction(sql, otherWallet);
    const rejected = await insertReversal(sql, wallet, otherBet, {
      status: "REJECTED",
      reference_transaction_id: null,
    });
    expect(rejected.reference_external_transaction_id).toBe(otherBet.external_transaction_id);
    expect(rejected.reference_transaction_id).toBeNull();
  });

  test.each(["PROCESSED", "REJECTED"])("rejects %s without balance_after", async (status) => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status, balance_after: null }),
      SQLSTATE.checkViolation,
      "wager_transactions_balance_after_required",
    );
  });

  test("rejects moving to PROCESSED without balance_after", async () => {
    const wallet = await insertWallet(sql);
    const pending = await insertTransaction(sql, wallet, { status: "PENDING" });
    await expectViolation(
      () => sql`UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now() WHERE id = ${pending.id}`,
      SQLSTATE.checkViolation,
      "wager_transactions_balance_after_required",
    );
  });

  test.each(["PENDING", "PENDING_REFERENCE", "FAILED"])("allows %s without balance_after", async (status) => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet, { status, balance_after: null });
    expect(transaction.balance_after).toBeNull();
  });

  test.each([
    ["PROCESSED", "0.00"],
    ["REJECTED", "99999999999999999.99"],
  ])("stores balance_after exactly for %s: %s", async (status, balance_after) => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet, { status, balance_after });
    expect(transaction.balance_after).toBe(balance_after);
  });

  test("rejects PENDING_REFERENCE without next_attempt_at", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status: "PENDING_REFERENCE", next_attempt_at: null }),
      SQLSTATE.checkViolation,
      "wager_transactions_pending_reference_scheduled",
    );
  });

  test("rejects moving to PENDING_REFERENCE without next_attempt_at", async () => {
    const wallet = await insertWallet(sql);
    const pending = await insertTransaction(sql, wallet, { status: "PENDING" });
    await expectViolation(
      () => sql`UPDATE wager_transactions SET status = 'PENDING_REFERENCE' WHERE id = ${pending.id}`,
      SQLSTATE.checkViolation,
      "wager_transactions_pending_reference_scheduled",
    );
  });

  test("allows other statuses without next_attempt_at", async () => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet, { status: "PENDING", next_attempt_at: null });
    expect(transaction.next_attempt_at).toBeNull();
  });

  test("rejects an invalid kind", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { kind: "JACKPOT" }),
      SQLSTATE.checkViolation,
      "wager_transactions_kind_valid",
    );
  });

  test("rejects an invalid status", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status: "DONE" }),
      SQLSTATE.checkViolation,
      "wager_transactions_status_valid",
    );
  });

  test.each(["OPENING", "BET", "WIN", "REFUND", "ROLLBACK"])("rejects a zero amount for %s", async (kind) => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { kind, amount: "0.00", reference_external_transaction_id: "ref" }),
      SQLSTATE.checkViolation,
      "wager_transactions_amount_valid",
    );
  });

  test.each(["BET", "LOSS"])("rejects a negative amount for %s", async (kind) => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { kind, amount: "-1.00" }),
      SQLSTATE.checkViolation,
      "wager_transactions_amount_valid",
    );
  });

  test("accepts a LOSS with a zero amount", async () => {
    const wallet = await insertWallet(sql);
    const loss = await insertTransaction(sql, wallet, { kind: "LOSS", amount: "0.00" });
    expect(loss.amount).toBe("0.00");
  });

  test.each(["REFUND", "ROLLBACK"])("rejects %s without a reference", async (kind) => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { kind, status: "PENDING" }),
      SQLSTATE.checkViolation,
      "wager_transactions_reversal_requires_reference",
    );
  });

  test("allows a reversal whose reference is still unresolved", async () => {
    const wallet = await insertWallet(sql);
    await insertTransaction(sql, wallet, {
      kind: "ROLLBACK",
      status: "PENDING_REFERENCE",
      reference_external_transaction_id: "not-arrived-yet",
      next_attempt_at: new Date(),
    });
  });

  test.each(["REJECTED", "FAILED"])("rejects %s without a failure code", async (status) => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status, failure_code: null }),
      SQLSTATE.checkViolation,
      "wager_transactions_failure_code_iff_failed",
    );
  });

  test.each(["PENDING", "PENDING_REFERENCE", "PROCESSED"])("rejects %s with a failure code", async (status) => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status, failure_code: "SOME_FAILURE" }),
      SQLSTATE.checkViolation,
      "wager_transactions_failure_code_iff_failed",
    );
  });

  test("rejects PROCESSED without processed_at", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status: "PROCESSED", processed_at: null }),
      SQLSTATE.checkViolation,
      "wager_transactions_processed_at_iff_processed",
    );
  });

  test("rejects processed_at on a non-PROCESSED status", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { status: "PENDING", processed_at: new Date() }),
      SQLSTATE.checkViolation,
      "wager_transactions_processed_at_iff_processed",
    );
  });

  test("defaults attempts to 0", async () => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    expect(transaction.attempts).toBe(0);
  });
});

describe("reversals", () => {
  test("rejects a second REFUND of the same reference", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    await insertReversal(sql, wallet, bet, { kind: "REFUND" });
    await expectViolation(
      () => insertReversal(sql, wallet, bet, { kind: "REFUND" }),
      SQLSTATE.uniqueViolation,
      "wager_transactions_one_reversal_per_reference",
    );
  });

  test("rejects a ROLLBACK of a reference that was already refunded", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    await insertReversal(sql, wallet, bet, { kind: "REFUND" });
    await expectViolation(
      () => insertReversal(sql, wallet, bet, { kind: "ROLLBACK" }),
      SQLSTATE.uniqueViolation,
      "wager_transactions_one_reversal_per_reference",
    );
  });

  test("rejects promoting a second reversal to PROCESSED", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    await insertReversal(sql, wallet, bet);
    const pending = await insertReversal(sql, wallet, bet, { status: "PENDING" });
    await expectViolation(
      () => sql`
        UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now(), balance_after = 100
        WHERE id = ${pending.id}
      `,
      SQLSTATE.uniqueViolation,
      "wager_transactions_one_reversal_per_reference",
    );
  });

  test("lets exactly one of several simultaneous reversals win", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => insertReversal(sql, wallet, bet)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          errno: SQLSTATE.uniqueViolation,
          constraint: "wager_transactions_one_reversal_per_reference",
        });
      }
    }
  });

  test("does not count rejected reversals, so they stay auditable", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    await insertReversal(sql, wallet, bet, { status: "REJECTED" });
    await insertReversal(sql, wallet, bet, { status: "REJECTED" });
    await insertReversal(sql, wallet, bet, { status: "PROCESSED" });
  });

  test("allows a ROLLBACK of a REFUND, since the reference differs", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    const refund = await insertReversal(sql, wallet, bet, { kind: "REFUND" });
    await insertReversal(sql, wallet, refund, { kind: "ROLLBACK" });
  });

  test("rejects a processed reversal with no resolved reference", async () => {
    const wallet = await insertWallet(sql);
    const bet = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertReversal(sql, wallet, bet, { reference_transaction_id: null }),
      SQLSTATE.checkViolation,
      "wager_transactions_processed_reversal_resolved",
    );
  });
});

describe("OPENING", () => {
  const opening = (wallet: Record<string, unknown>) => ({
    kind: "OPENING",
    provider_id: "internal",
    external_transaction_id: `opening:${wallet.id}`,
    idempotency_key: `internal:opening:${wallet.id}`,
    round_id: "opening",
    game_id: "opening",
  });

  test("accepts an opening transaction", async () => {
    const wallet = await insertWallet(sql);
    await insertTransaction(sql, wallet, opening(wallet));
  });

  test("rejects OPENING from a real provider", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { ...opening(wallet), provider_id: "provider-a" }),
      SQLSTATE.checkViolation,
      "wager_transactions_internal_provider_iff_opening",
    );
  });

  test("rejects a provider operation using the internal provider id", async () => {
    const wallet = await insertWallet(sql);
    await expectViolation(
      () => insertTransaction(sql, wallet, { kind: "BET", provider_id: "internal" }),
      SQLSTATE.checkViolation,
      "wager_transactions_internal_provider_iff_opening",
    );
  });

  test("rejects a second opening for the same wallet", async () => {
    const wallet = await insertWallet(sql);
    await insertTransaction(sql, wallet, opening(wallet));
    await expectViolation(
      () =>
        insertTransaction(sql, wallet, {
          ...opening(wallet),
          external_transaction_id: "other",
          idempotency_key: "other",
        }),
      SQLSTATE.uniqueViolation,
      "wager_transactions_one_opening_per_wallet",
    );
  });
});

describe("wallet_ledger_entries", () => {
  async function entry() {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    const ledger = await insertLedgerEntry(sql, wallet, transaction);
    return { wallet, transaction, ledger };
  }

  test("accepts correct debit and credit entries", async () => {
    const wallet = await insertWallet(sql);
    const debit = await insertTransaction(sql, wallet);
    const credit = await insertTransaction(sql, wallet, { kind: "WIN" });
    await insertLedgerEntry(sql, wallet, debit, { balance_before: "25.00", balance_after: "0.00" });
    await insertLedgerEntry(sql, wallet, credit, {
      direction: "CREDIT",
      balance_before: "0.00",
      balance_after: "25.00",
    });
  });

  test("rejects a second entry for the same transaction and wallet", async () => {
    const { wallet, transaction } = await entry();
    await expectViolation(
      () => insertLedgerEntry(sql, wallet, transaction),
      SQLSTATE.uniqueViolation,
      "wallet_ledger_entries_transaction_wallet_unique",
    );
  });

  test("rejects an entry on a wallet other than the transaction's", async () => {
    const wallet = await insertWallet(sql);
    const otherWallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertLedgerEntry(sql, otherWallet, transaction),
      SQLSTATE.foreignKeyViolation,
      "wallet_ledger_entries_transaction_wallet_fk",
    );
  });

  test.each([
    ["DEBIT", "100.00", "76.00"],
    ["DEBIT", "100.00", "125.00"],
    ["CREDIT", "100.00", "124.99"],
    ["CREDIT", "100.00", "75.00"],
  ])("rejects wrong arithmetic: %s from %s to %s", async (direction, balance_before, balance_after) => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertLedgerEntry(sql, wallet, transaction, { direction, balance_before, balance_after }),
      SQLSTATE.checkViolation,
      "wallet_ledger_entries_arithmetic",
    );
  });

  test("rejects a debit that would leave a negative balance", async () => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertLedgerEntry(sql, wallet, transaction, { balance_before: "10.00", balance_after: "-15.00" }),
      SQLSTATE.checkViolation,
      "wallet_ledger_entries_balance_after_non_negative",
    );
  });

  test("rejects a negative balance_before", async () => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    await expectViolation(
      () =>
        insertLedgerEntry(sql, wallet, transaction, {
          direction: "CREDIT",
          balance_before: "-25.00",
          balance_after: "0.00",
        }),
      SQLSTATE.checkViolation,
      "wallet_ledger_entries_balance_before_non_negative",
    );
  });

  test.each(["0.00", "-25.00"])("rejects amount %s", async (amount) => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    await expectViolation(
      () => insertLedgerEntry(sql, wallet, transaction, { amount, balance_before: "100.00", balance_after: "100.00" }),
      SQLSTATE.checkViolation,
      "wallet_ledger_entries_amount_positive",
    );
  });

  test("rejects an invalid direction", async () => {
    const wallet = await insertWallet(sql);
    const transaction = await insertTransaction(sql, wallet);
    // An unknown direction breaks both checks, and Postgres reports the first by name.
    await expectViolation(
      () => insertLedgerEntry(sql, wallet, transaction, { direction: "SIDEWAYS" }),
      SQLSTATE.checkViolation,
      "wallet_ledger_entries_arithmetic",
    );
  });

  test("rejects UPDATE and keeps the row intact", async () => {
    const { ledger } = await entry();
    await expectAppendOnly(() => sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE id = ${ledger.id}`, "UPDATE");
    const [row] = await sql`SELECT amount FROM wallet_ledger_entries WHERE id = ${ledger.id}`;
    expect(row.amount).toBe("25.00");
  });

  test("rejects DELETE and keeps the row", async () => {
    const { ledger } = await entry();
    await expectAppendOnly(() => sql`DELETE FROM wallet_ledger_entries WHERE id = ${ledger.id}`, "DELETE");
    const rows = await sql`SELECT id FROM wallet_ledger_entries WHERE id = ${ledger.id}`;
    expect(rows).toHaveLength(1);
  });

  test("rejects TRUNCATE and keeps the row", async () => {
    const { ledger } = await entry();
    await expectAppendOnly(() => sql`TRUNCATE wallet_ledger_entries`, "TRUNCATE");
    const rows = await sql`SELECT id FROM wallet_ledger_entries WHERE id = ${ledger.id}`;
    expect(rows).toHaveLength(1);
  });

  test("rejects TRUNCATE reaching the ledger through CASCADE", async () => {
    const { ledger } = await entry();
    await expectAppendOnly(() => sql`TRUNCATE wallets CASCADE`, "TRUNCATE");
    const rows = await sql`SELECT id FROM wallet_ledger_entries WHERE id = ${ledger.id}`;
    expect(rows).toHaveLength(1);
  });

  test("blocks deleting a transaction or wallet that has entries", async () => {
    const { wallet, transaction } = await entry();
    await expectViolation(
      () => sql`DELETE FROM wager_transactions WHERE id = ${transaction.id}`,
      SQLSTATE.foreignKeyViolation,
      "wallet_ledger_entries_transaction_wallet_fk",
    );
    const error = await sql`DELETE FROM wallets WHERE id = ${wallet.id}`.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ errno: SQLSTATE.foreignKeyViolation });
  });
});

describe("inbox_messages", () => {
  test("rejects the same message for the same consumer", async () => {
    const message = await insertInboxMessage(sql);
    await expectViolation(
      () => insertInboxMessage(sql, { message_id: message.message_id }),
      SQLSTATE.uniqueViolation,
      "inbox_messages_pk",
    );
  });

  test("allows the same message for another consumer", async () => {
    const message = await insertInboxMessage(sql);
    await insertInboxMessage(sql, { message_id: message.message_id, consumer_name: "other-consumer" });
  });
});

describe("outbox_messages", () => {
  test("applies the attempts and next_attempt_at defaults", async () => {
    const [row] = await sql`
      INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
      VALUES (${randomUUIDv7()}, ${randomUUIDv7()}, 'WalletBalanceChanged', ${{ eventId: "e-1" }}, now())
      RETURNING *
    `;
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toBeInstanceOf(Date);
    expect(row.published_at).toBeNull();
    expect(row.payload).toEqual({ eventId: "e-1" });
  });
});

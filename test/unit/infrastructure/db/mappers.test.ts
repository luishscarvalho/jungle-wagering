import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../../src/domain/events/events";
import { LedgerDirection, WalletLedgerEntry } from "../../../../src/domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../../src/domain/messaging/outbox-message";
import { FailureCode } from "../../../../src/domain/shared/failure-code";
import { WagerTransactionKind } from "../../../../src/domain/transaction/wager-transaction";
import {
  inboxMessageFromRecord,
  inboxMessageToRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  moneyFromColumn,
  moneyToColumn,
  outboxMessageFromRecord,
  outboxMessageToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "../../../../src/infrastructure/db/mappers";
import { AT, aReference, aTransaction, aWallet, brl, LATER } from "../../domain/fixtures";

describe("money columns", () => {
  test.each([
    ["0.00", 0n],
    ["0.05", 5n],
    ["25.50", 2550n],
    ["-0.05", -5n],
    ["-40.00", -4000n],
    ["99999999999999999.99", 9999999999999999999n],
  ])("%s converts both ways without loss", (column, minor) => {
    const money = moneyFromColumn(column, "BRL");
    expect(money.minorUnits).toBe(minor);
    expect(moneyToColumn(money)).toBe(column);
  });

  test.each(["25", "25.5", "25.000", "abc", ""])("rejects %j, which is not scale 2", (column) => {
    expect(() => moneyFromColumn(column, "BRL")).toThrow();
  });
});

describe("round trips", () => {
  test("wallet", () => {
    const wallet = aWallet("12.34", { version: 3, updatedAt: LATER });
    const record = walletToRecord(wallet);
    expect(record).toMatchObject({ balance: "12.34", currency: "BRL", version: 3 });
    expect(walletToRecord(walletFromRecord(record))).toEqual(record);
  });

  test("transaction with every optional field empty", () => {
    const record = transactionToRecord(aTransaction(WagerTransactionKind.Bet));
    expect(record).toMatchObject({
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      failureCode: null,
      balanceAfter: null,
      nextAttemptAt: null,
      processedAt: null,
    });
    expect(transactionToRecord(transactionFromRecord(record))).toEqual(record);
    expect(transactionFromRecord(record).balanceAfter).toBeUndefined();
  });

  test("transaction with every optional field set", () => {
    const transaction = aReference(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: "ext",
      referenceTransactionId: "tx",
      failureCode: FailureCode.AmountMismatch,
      balanceAfter: brl("1.00"),
      nextAttemptAt: LATER,
      processedAt: AT,
      attempts: 4,
    });
    const record = transactionToRecord(transaction);
    expect(record).toMatchObject({ amount: "25.00", currency: "BRL", balanceAfter: "1.00", attempts: 4 });
    expect(transactionToRecord(transactionFromRecord(record))).toEqual(record);
  });

  test("a balanceAfter of zero is not mistaken for absent", () => {
    const transaction = aReference(WagerTransactionKind.Bet, { balanceAfter: brl("0.00") });
    expect(transactionFromRecord(transactionToRecord(transaction)).balanceAfter?.isZero()).toBe(true);
  });

  test("ledger entry, taking the currency from the wallet", () => {
    const entry = WalletLedgerEntry.create({
      id: "e",
      walletId: "w",
      transactionId: "t",
      direction: LedgerDirection.Debit,
      money: brl("25.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("75.00"),
      createdAt: AT,
    });
    const record = ledgerEntryToRecord(entry);
    expect(record).toMatchObject({ amount: "25.00", balanceBefore: "100.00", balanceAfter: "75.00" });
    const restored = ledgerEntryFromRecord(record, "BRL");
    expect(ledgerEntryToRecord(restored)).toEqual(record);
    expect(restored.isBalanced()).toBe(true);
  });

  test("inbox message", () => {
    const message = InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: AT });
    const record = inboxMessageToRecord(message);
    expect(record.processedAt).toBeNull();
    expect(inboxMessageFromRecord(record).isProcessed()).toBe(false);
    message.markProcessed(LATER);
    expect(inboxMessageFromRecord(inboxMessageToRecord(message)).processedAt).toEqual(LATER);
  });

  test("outbox message", () => {
    const wallet = aWallet("100.00");
    const entry = wallet.debit({ entryId: "e", transactionId: "t", money: brl("1.00"), at: AT });
    const event = WalletBalanceChanged.from(wallet, entry, { eventId: "evt", correlationId: "c", occurredAt: AT });
    const record = outboxMessageToRecord(OutboxMessage.enqueue(event));
    expect(record).toMatchObject({ id: "evt", eventType: "WalletBalanceChanged", attempts: 0, publishedAt: null });
    expect(outboxMessageToRecord(outboxMessageFromRecord(record))).toEqual(record);
  });
});

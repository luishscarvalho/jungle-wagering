import { describe, expect, test } from "bun:test";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../src/domain/events/events";
import { IntegrationEvent } from "../../../src/domain/events/integration-event";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { WagerTransactionKind as Kind } from "../../../src/domain/transaction/wager-transaction";
import { InvalidTransactionStateError } from "../../../src/domain/transaction/wager-transaction.errors";
import { AT, aTransaction, aWallet, brl, LATER, PLAYER_ID, WALLET_ID } from "./fixtures";

const context = { eventId: "evt-1", correlationId: "corr-1", occurredAt: LATER };

const processedBet = () => {
  const bet = aTransaction(Kind.Bet);
  bet.markProcessed(undefined, LATER, brl("75.00"));
  return bet;
};

const rejectedBet = () => {
  const bet = aTransaction(Kind.Bet);
  bet.reject(FailureCode.InsufficientFunds, brl("10.00"));
  return bet;
};

const pendingRefund = () => {
  const refund = aTransaction(Kind.Refund);
  refund.markPendingReference(AT);
  return refund;
};

function walletChange() {
  const wallet = aWallet("100.00");
  const entry = wallet.debit({ entryId: "e", transactionId: "tx-1", money: brl("25.00"), at: LATER });
  return WalletBalanceChanged.from(wallet, entry, context);
}

const transactionData = {
  transactionId: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: "round-1",
  gameId: "game-1",
  money: { amount: "25.00", currency: "BRL" },
};

function hasMoneyInstance(value: unknown): boolean {
  if (value instanceof Money) return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(hasMoneyInstance);
}

const allEvents: [string, () => IntegrationEvent<unknown>][] = [
  ["WagerTransactionProcessed", () => WagerTransactionProcessed.from(processedBet(), context)],
  ["WagerTransactionRejected", () => WagerTransactionRejected.from(rejectedBet(), context)],
  ["WagerTransactionPendingReference", () => WagerTransactionPendingReference.from(pendingRefund(), context)],
  ["WalletBalanceChanged", walletChange],
];

describe.each(allEvents)("%s", (eventType, build) => {
  test("extends IntegrationEvent with its type and version on the class", () => {
    const event = build();
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe(eventType);
    expect(event.version).toBe(1);
  });

  test("has an envelope with an ISO date", () => {
    expect(build().toJSON()).toMatchObject({
      eventId: "evt-1",
      eventType,
      correlationId: "corr-1",
      occurredAt: "2026-01-01T00:01:00.000Z",
      version: 1,
    });
  });

  test("data carries MoneyProps, never Money", () => {
    const event = build();
    expect(hasMoneyInstance(event.data)).toBe(false);
    expect(hasMoneyInstance(event.toJSON())).toBe(false);
  });

  test("survives a JSON round trip unchanged", () => {
    const envelope = build().toJSON();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope as Record<string, unknown>);
  });

  test("data is frozen", () => {
    expect(Object.isFrozen(build().data)).toBe(true);
  });
});

describe("WagerTransactionProcessed", () => {
  test("has the transaction as aggregate and the observed balance", () => {
    const event = WagerTransactionProcessed.from(processedBet(), context);
    expect(event.aggregateId).toBe("tx-1");
    expect(event.data).toEqual({
      ...transactionData,
      kind: "BET",
      balanceAfter: { amount: "75.00", currency: "BRL" },
    });
  });

  test("covers LOSS", () => {
    const loss = aTransaction(Kind.Loss);
    loss.markProcessed(undefined, LATER, brl("100.00"));
    expect(WagerTransactionProcessed.from(loss, context).data.kind).toBe("LOSS");
  });

  test("includes the resolved reference", () => {
    const refund = aTransaction(Kind.Refund);
    refund.markProcessed("tx-ref", LATER, brl("125.00"));
    expect(WagerTransactionProcessed.from(refund, context).data.referenceTransactionId).toBe("tx-ref");
  });

  test.each([
    ["pending", () => aTransaction(Kind.Bet)],
    ["rejected", rejectedBet],
  ])("refuses a %s transaction", (_label, build) => {
    expect(() => WagerTransactionProcessed.from(build(), context)).toThrow(InvalidTransactionStateError);
  });
});

describe("WagerTransactionRejected", () => {
  test("carries the failure code and the observed balance", () => {
    const event = WagerTransactionRejected.from(rejectedBet(), context);
    expect(event.aggregateId).toBe("tx-1");
    expect(event.data).toEqual({
      ...transactionData,
      kind: "BET",
      failureCode: FailureCode.InsufficientFunds,
      balanceAfter: { amount: "10.00", currency: "BRL" },
    });
  });

  test("refuses a processed transaction", () => {
    expect(() => WagerTransactionRejected.from(processedBet(), context)).toThrow(InvalidTransactionStateError);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("carries what it is waiting for and when it retries", () => {
    const event = WagerTransactionPendingReference.from(pendingRefund(), context);
    expect(event.aggregateId).toBe("tx-1");
    expect(event.data).toEqual({
      ...transactionData,
      kind: "REFUND",
      referenceExternalTransactionId: "ext-ref",
      attempts: 0,
      nextAttemptAt: "2026-01-01T00:00:01.000Z",
    });
  });

  test("refuses a transaction not waiting", () => {
    expect(() => WagerTransactionPendingReference.from(aTransaction(Kind.Refund), context)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe("WalletBalanceChanged", () => {
  test("has the wallet as aggregate and the movement", () => {
    const event = walletChange();
    expect(event.aggregateId).toBe(WALLET_ID);
    expect(event.data).toEqual({
      walletId: WALLET_ID,
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
  });
});

describe("envelope", () => {
  test("includes causationId when given", () => {
    const event = WagerTransactionProcessed.from(processedBet(), { ...context, causationId: "msg-1" });
    expect(event.toJSON().causationId).toBe("msg-1");
  });

  test("omits causationId when absent", () => {
    const envelope = WagerTransactionProcessed.from(processedBet(), context).toJSON();
    expect("causationId" in envelope).toBe(false);
  });
});

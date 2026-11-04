import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { CurrencyMismatchError } from "../../../src/domain/money/money.errors";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { computePayloadHash } from "../../../src/domain/transaction/payload-hash";
import {
  INTERNAL_PROVIDER_ID,
  MAX_REFERENCE_ATTEMPTS,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/transaction/wager-transaction";
import {
  InvalidFailureCodeError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  KindNotAllowedError,
} from "../../../src/domain/transaction/wager-transaction.errors";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { aFinished, AT, aPendingReference, aReference, aTransaction, brl, createProps, LATER, usd } from "./fixtures";

const REJECT_CODE = FailureCode.InsufficientFunds;
const FAIL_CODE = FailureCode.ProcessingFailed;
const secondsAfter = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

describe("create", () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])("%s starts as PENDING", (kind) => {
    const transaction = aTransaction(kind);
    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.attempts).toBe(0);
    expect(transaction.nextAttemptAt).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.isTerminal()).toBe(false);
  });

  test("rejects OPENING coming from outside", () => {
    expect(() => WagerTransaction.create(createProps(Kind.Opening))).toThrow(KindNotAllowedError);
  });

  test("rejects the reserved internal provider id", () => {
    expect(() => aTransaction(Kind.Bet, { providerId: INTERNAL_PROVIDER_ID })).toThrow(InvalidWagerTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s requires a reference", (kind) => {
    expect(() => aTransaction(kind, { referenceExternalTransactionId: undefined })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => aTransaction(kind, { referenceExternalTransactionId: "" })).toThrow(InvalidWagerTransactionError);
  });

  test("BET cannot have a reference", () => {
    expect(() => aTransaction(Kind.Bet, { referenceExternalTransactionId: "ext" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([Kind.Win, Kind.Loss])("%s may have a reference or not", (kind) => {
    expect(aTransaction(kind).referenceExternalTransactionId).toBeUndefined();
    expect(aTransaction(kind, { referenceExternalTransactionId: "e" }).referenceExternalTransactionId).toBe("e");
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])("%s rejects a zero amount", (kind) => {
    expect(() => aTransaction(kind, { money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS accepts a zero amount", () => {
    expect(aTransaction(Kind.Loss, { money: brl("0.00") }).money.isZero()).toBe(true);
  });

  test.each([Kind.Bet, Kind.Loss])("%s rejects a negative amount", (kind) => {
    expect(() => aTransaction(kind, { money: brl("1.00").negate() })).toThrow(InvalidWagerTransactionError);
  });

  test.each(["providerId", "externalTransactionId", "idempotencyKey", "walletId", "playerId", "roundId", "gameId"])(
    "rejects an empty %s",
    (field) => {
      expect(() => aTransaction(Kind.Bet, { [field]: "" })).toThrow(InvalidWagerTransactionError);
    },
  );
});

describe("createOpening", () => {
  const opened = (balance = "1000.00") =>
    Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl(balance), at: AT });

  test("follows the OPENING convention and starts applied", () => {
    const opening = WagerTransaction.createOpening({ id: "t", wallet: opened(), at: AT });
    expect(opening).toMatchObject({
      id: "t",
      providerId: "internal",
      externalTransactionId: "opening:w-1",
      idempotencyKey: "internal:opening:w-1",
      roundId: "opening",
      gameId: "opening",
      walletId: "w-1",
      playerId: "p-1",
      kind: Kind.Opening,
      status: Status.Processed,
      processedAt: AT,
    });
    expect(opening.money.equals(brl("1000.00"))).toBe(true);
    expect(opening.balanceAfter?.equals(brl("1000.00"))).toBe(true);
    expect(opening.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("rejects a zero balance, which has no OPENING", () => {
    expect(() => WagerTransaction.createOpening({ id: "t", wallet: opened("0.00"), at: AT })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("rejects a wallet that already moved", () => {
    const wallet = opened();
    wallet.credit({ entryId: "e", transactionId: "x", money: brl("1.00"), at: AT });
    expect(() => WagerTransaction.createOpening({ id: "t", wallet, at: AT })).toThrow(InvalidWagerTransactionError);
  });
});

describe("valid transitions", () => {
  const starts: [string, () => WagerTransaction][] = [
    ["PENDING", () => aTransaction(Kind.Refund)],
    ["PENDING_REFERENCE", () => aPendingReference(Kind.Refund, 3)],
  ];

  describe.each(starts)("from %s", (_label, start) => {
    test("to PROCESSED", () => {
      const transaction = start();
      transaction.markProcessed("tx-ref", LATER, brl("75.00"));
      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.referenceTransactionId).toBe("tx-ref");
      expect(transaction.processedAt).toEqual(LATER);
      expect(transaction.balanceAfter?.equals(brl("75.00"))).toBe(true);
      expect(transaction.nextAttemptAt).toBeUndefined();
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.isTerminal()).toBe(true);
    });

    test("to REJECTED, with no processedAt", () => {
      const transaction = start();
      transaction.reject(REJECT_CODE, brl("75.00"));
      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(REJECT_CODE);
      expect(transaction.balanceAfter?.equals(brl("75.00"))).toBe(true);
      expect(transaction.processedAt).toBeUndefined();
      expect(transaction.nextAttemptAt).toBeUndefined();
      expect(transaction.isTerminal()).toBe(true);
    });

    test("to FAILED, with no balanceAfter", () => {
      const transaction = start();
      transaction.fail(FAIL_CODE);
      expect(transaction.status).toBe(Status.Failed);
      expect(transaction.failureCode).toBe(FAIL_CODE);
      expect(transaction.balanceAfter).toBeUndefined();
      expect(transaction.nextAttemptAt).toBeUndefined();
      expect(transaction.isTerminal()).toBe(true);
    });
  });

  test("PENDING to PENDING_REFERENCE schedules the first retry without counting it", () => {
    const transaction = aTransaction(Kind.Refund);
    transaction.markPendingReference(AT);
    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.attempts).toBe(0);
    expect(transaction.nextAttemptAt).toEqual(secondsAfter(AT, 1));
    expect(transaction.isTerminal()).toBe(false);
  });

  test("PENDING_REFERENCE to itself increments attempts and backs off", () => {
    const transaction = aTransaction(Kind.Refund);
    transaction.markPendingReference(AT);
    const expected: [number, number][] = [
      [1, 2],
      [2, 4],
      [3, 8],
      [4, 16],
      [5, 32],
      [6, 60],
      [7, 60],
      [8, 60],
      [9, 60],
    ];
    for (const [attempts, delay] of expected) {
      transaction.markPendingReference(LATER);
      expect(transaction.status).toBe(Status.PendingReference);
      expect(transaction.attempts).toBe(attempts);
      expect(transaction.nextAttemptAt).toEqual(secondsAfter(LATER, delay));
    }
  });

  test("a WIN with no reference can be processed without one", () => {
    const transaction = aTransaction(Kind.Win);
    transaction.markProcessed(undefined, LATER, brl("125.00"));
    expect(transaction.referenceTransactionId).toBeUndefined();
  });
});

describe("invalid transitions", () => {
  const terminals = [Status.Processed, Status.Rejected, Status.Failed];

  test.each(terminals)("%s cannot go to PROCESSED", (status) => {
    expect(() => aFinished(status).markProcessed(undefined, LATER, brl("1.00"))).toThrow(InvalidTransactionStateError);
  });

  test.each(terminals)("%s cannot go to REJECTED", (status) => {
    expect(() => aFinished(status).reject(REJECT_CODE, brl("1.00"))).toThrow(InvalidTransactionStateError);
  });

  test.each(terminals)("%s cannot go to FAILED", (status) => {
    expect(() => aFinished(status).fail(FAIL_CODE)).toThrow(InvalidTransactionStateError);
  });

  test.each(terminals)("%s cannot go to PENDING_REFERENCE", (status) => {
    const finished = WagerTransaction.rehydrate({
      ...createProps(Kind.Refund),
      payloadHash: "h",
      status,
      attempts: 0,
    });
    expect(() => finished.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
  });

  test("a failed transition changes nothing", () => {
    const transaction = aReference(Kind.Bet, { status: Status.Processed });
    expect(() => transaction.reject(REJECT_CODE, brl("1.00"))).toThrow(InvalidTransactionStateError);
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.balanceAfter?.equals(brl("75.00"))).toBe(true);
  });

  test("cannot wait for a reference it does not have", () => {
    expect(() => aTransaction(Kind.Win).markPendingReference(AT)).toThrow(InvalidTransactionStateError);
  });

  test("cannot reschedule past the attempt limit", () => {
    const transaction = aPendingReference(Kind.Refund, MAX_REFERENCE_ATTEMPTS - 1);
    expect(() => transaction.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
    expect(transaction.attempts).toBe(MAX_REFERENCE_ATTEMPTS - 1);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s cannot be processed with no resolved reference", (kind) => {
    expect(() => aTransaction(kind).markProcessed(undefined, LATER, brl("1.00"))).toThrow(InvalidTransactionStateError);
  });

  test("balanceAfter must be in the transaction's currency", () => {
    expect(() => aTransaction(Kind.Bet).markProcessed(undefined, LATER, usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => aTransaction(Kind.Bet).reject(REJECT_CODE, usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("balanceAfter cannot be negative", () => {
    const negative = brl("1.00").negate();
    expect(() => aTransaction(Kind.Bet).markProcessed(undefined, LATER, negative)).toThrow(InvalidTransactionStateError);
    expect(() => aTransaction(Kind.Bet).reject(REJECT_CODE, negative)).toThrow(InvalidTransactionStateError);
  });

  test.each([
    FailureCode.CurrencyMismatch,
    FailureCode.PlayerMismatch,
    FailureCode.WalletNotFound,
    FailureCode.KindNotAllowed,
    FailureCode.InvalidPayload,
    FailureCode.IdempotencyConflict,
    FailureCode.ProcessingFailed,
  ])("reject refuses non-business code %s", (code) => {
    expect(() => aTransaction(Kind.Bet).reject(code, brl("1.00"))).toThrow(InvalidFailureCodeError);
  });

  test.each([FailureCode.InsufficientFunds, FailureCode.CurrencyMismatch, FailureCode.IdempotencyConflict])(
    "fail refuses non-infrastructure code %s",
    (code) => {
      expect(() => aTransaction(Kind.Bet).fail(code)).toThrow(InvalidFailureCodeError);
    },
  );
});

describe("rehydrate", () => {
  test("restores every field without revalidating transitions", () => {
    const transaction = WagerTransaction.rehydrate({
      ...createProps(Kind.Bet),
      payloadHash: "stored-hash",
      status: Status.PendingReference,
      referenceTransactionId: "tx-ref",
      failureCode: REJECT_CODE,
      balanceAfter: brl("1.00"),
      attempts: 42,
      nextAttemptAt: LATER,
      processedAt: AT,
    });
    expect(transaction).toMatchObject({
      payloadHash: "stored-hash",
      status: Status.PendingReference,
      referenceTransactionId: "tx-ref",
      failureCode: REJECT_CODE,
      attempts: 42,
      nextAttemptAt: LATER,
      processedAt: AT,
    });
  });

  test("restores OPENING, which create refuses", () => {
    const transaction = WagerTransaction.rehydrate({
      ...createProps(Kind.Opening),
      payloadHash: "h",
      status: Status.Processed,
      attempts: 0,
    });
    expect(transaction.kind).toBe(Kind.Opening);
  });
});

describe("queries", () => {
  test("affectsBalance is false only for LOSS", () => {
    expect(aTransaction(Kind.Loss).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
      expect(aTransaction(kind).affectsBalance()).toBe(true);
    }
  });

  test("requiresReference is true only for REFUND and ROLLBACK", () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) expect(aTransaction(kind).requiresReference()).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) expect(aTransaction(kind).requiresReference()).toBe(false);
  });

  test("isLastReferenceAttempt turns true on the 10th retry", () => {
    expect(aPendingReference(Kind.Refund, 8).isLastReferenceAttempt()).toBe(false);
    expect(aPendingReference(Kind.Refund, 9).isLastReferenceAttempt()).toBe(true);
  });

  test("isLastReferenceAttempt is false outside PENDING_REFERENCE", () => {
    expect(aTransaction(Kind.Refund).isLastReferenceAttempt()).toBe(false);
  });
});

describe("matchesPayload", () => {
  const hashOf = (overrides: Parameters<typeof createProps>[1] = {}) => {
    const props = createProps(Kind.Bet, overrides);
    return computePayloadHash({ ...props, money: props.money.toJSON() });
  };

  test("is true for an identical payload", () => {
    expect(aTransaction(Kind.Bet).matchesPayload(hashOf())).toBe(true);
  });

  test("ignores the idempotency key and the internal id", () => {
    expect(aTransaction(Kind.Bet).matchesPayload(hashOf({ idempotencyKey: "other", id: "other" }))).toBe(true);
  });

  test.each([
    ["amount", { money: brl("25.01") }],
    ["currency", { money: usd("25.00") }],
    ["round", { roundId: "round-2" }],
    ["game", { gameId: "game-2" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["provider", { providerId: "provider-b" }],
    ["external id", { externalTransactionId: "ext-2" }],
    ["reference", { referenceExternalTransactionId: "ext-9" }],
  ])("is false with the same key and a divergent %s", (_label, overrides) => {
    expect(aTransaction(Kind.Bet).matchesPayload(hashOf(overrides))).toBe(false);
  });

  test("is false for a divergent kind", () => {
    const props = createProps(Kind.Win);
    const hash = computePayloadHash({ ...props, money: props.money.toJSON() });
    expect(aTransaction(Kind.Bet).matchesPayload(hash)).toBe(false);
  });

  test("uses the stored hash after rehydration", () => {
    const transaction = aReference(Kind.Bet, { payloadHash: "stored" });
    expect(transaction.matchesPayload("stored")).toBe(true);
    expect(transaction.matchesPayload("other")).toBe(false);
  });
});

describe("ledgerDirectionFor", () => {
  test.each([
    [Kind.Bet, LedgerDirection.Debit],
    [Kind.Win, LedgerDirection.Credit],
    [Kind.Refund, LedgerDirection.Credit],
    [Kind.Loss, undefined],
  ])("%s gives %s", (kind, direction) => {
    expect(aTransaction(kind).ledgerDirectionFor()).toBe(direction);
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])("ROLLBACK of %s gives %s", (referenceKind, direction) => {
    expect(aTransaction(Kind.Rollback).ledgerDirectionFor(aReference(referenceKind))).toBe(direction);
  });

  test.each([Kind.Loss, Kind.Rollback])("ROLLBACK of %s has no direction to invert", (referenceKind) => {
    expect(() => aTransaction(Kind.Rollback).ledgerDirectionFor(aReference(referenceKind))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("ROLLBACK with no reference has no direction", () => {
    expect(() => aTransaction(Kind.Rollback).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

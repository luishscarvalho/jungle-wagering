import { describe, expect, test } from "bun:test";
import { InvalidLedgerEntryError, UnbalancedLedgerEntryError } from "../../../src/domain/ledger/wallet-ledger-entry.errors";
import { InvalidMessageStateError } from "../../../src/domain/messaging/messaging.errors";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/money/money.errors";
import { backoffDelayMs, nextAttemptAfter } from "../../../src/domain/shared/backoff";
import { DomainError } from "../../../src/domain/shared/domain-error";
import { FailureCategory, FailureCode, failureCategoryOf } from "../../../src/domain/shared/failure-code";
import {
  InvalidFailureCodeError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  KindNotAllowedError,
} from "../../../src/domain/transaction/wager-transaction.errors";
import { InsufficientFundsError, InvalidWalletOperationError } from "../../../src/domain/wallet/wallet.errors";

describe("failure codes", () => {
  test.each([
    ["INSUFFICIENT_FUNDS", FailureCategory.Business],
    ["REVERSAL_INSUFFICIENT_FUNDS", FailureCategory.Business],
    ["REFERENCE_NOT_FOUND", FailureCategory.Business],
    ["REFERENCE_INVALID_KIND", FailureCategory.Business],
    ["REFERENCE_MISMATCH", FailureCategory.Business],
    ["REFERENCE_NOT_PROCESSED", FailureCategory.Business],
    ["REFERENCE_ALREADY_REVERSED", FailureCategory.Business],
    ["AMOUNT_MISMATCH", FailureCategory.Business],
    ["INVALID_PAYLOAD", FailureCategory.Contract],
    ["CURRENCY_MISMATCH", FailureCategory.Contract],
    ["PLAYER_MISMATCH", FailureCategory.Contract],
    ["WALLET_NOT_FOUND", FailureCategory.Contract],
    ["KIND_NOT_ALLOWED", FailureCategory.Contract],
    ["RESOURCE_NOT_FOUND", FailureCategory.Contract],
    ["IDEMPOTENCY_CONFLICT", FailureCategory.Conflict],
    ["WALLET_ALREADY_EXISTS", FailureCategory.Conflict],
    ["INFRASTRUCTURE_UNAVAILABLE", FailureCategory.Infrastructure],
    ["PROCESSING_FAILED", FailureCategory.Infrastructure],
  ])("%s is %s", (code, category) => {
    expect(Object.values(FailureCode)).toContain(code as FailureCode);
    expect(failureCategoryOf(code as FailureCode)).toBe(category);
  });

  test("the table above covers every code", () => {
    expect(Object.values(FailureCode)).toHaveLength(18);
  });
});

describe("domain errors", () => {
  test.each([
    [new InvalidMoneyError("x"), "InvalidMoneyError", FailureCode.InvalidPayload],
    [new CurrencyMismatchError("BRL", "USD"), "CurrencyMismatchError", FailureCode.CurrencyMismatch],
    [new InsufficientFundsError("w"), "InsufficientFundsError", FailureCode.InsufficientFunds],
    [new InvalidWagerTransactionError("x"), "InvalidWagerTransactionError", FailureCode.InvalidPayload],
    [new KindNotAllowedError("OPENING"), "KindNotAllowedError", FailureCode.KindNotAllowed],
    [new InvalidTransactionStateError("x"), "InvalidTransactionStateError", undefined],
    [new InvalidFailureCodeError("x"), "InvalidFailureCodeError", undefined],
    [new InvalidWalletOperationError("x"), "InvalidWalletOperationError", undefined],
    [new InvalidLedgerEntryError("x"), "InvalidLedgerEntryError", undefined],
    [new UnbalancedLedgerEntryError(), "UnbalancedLedgerEntryError", undefined],
    [new InvalidMessageStateError("x"), "InvalidMessageStateError", undefined],
  ])("%s extends DomainError with its name and code", (error, name, code) => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.failureCode).toBe(code);
  });
});

describe("backoff", () => {
  test("doubles from 1s up to a 60s cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffDelayMs);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });

  test("stays at the cap for any retry count", () => {
    expect(backoffDelayMs(5000)).toBe(60000);
  });

  test("computes the next attempt from now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(nextAttemptAfter(now, 2)).toEqual(new Date("2026-01-01T00:00:02.000Z"));
    expect(now.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

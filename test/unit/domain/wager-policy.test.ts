import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { evaluateWagerPolicy, type WagerOutcome, type WagerPolicyInput } from "../../../src/domain/policy/wager-policy";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { backoffDelayMs } from "../../../src/domain/shared/backoff";
import {
  MAX_REFERENCE_ATTEMPTS,
  WagerTransaction,
  WagerTransactionKind as Kind,
  type WagerTransactionState,
  WagerTransactionStatus as Status,
} from "../../../src/domain/transaction/wager-transaction";
import { InvalidTransactionStateError } from "../../../src/domain/transaction/wager-transaction.errors";
import {
  aFinished,
  AT,
  aPendingReference,
  aReference,
  aTransaction,
  aWallet,
  brl,
  createProps,
  LATER,
  usd,
} from "./fixtures";

function evaluate(
  transaction: WagerTransaction,
  overrides: Partial<Omit<WagerPolicyInput, "transaction">> = {},
) {
  return evaluateWagerPolicy({
    transaction,
    wallet: aWallet("100.00"),
    reference: undefined,
    referenceAlreadyReversed: false,
    ...overrides,
  });
}

const rejected = (failureCode: FailureCode): WagerOutcome => ({ type: "reject", failureCode });
const awaiting: WagerOutcome = { type: "await-reference" };
const processed = (direction: LedgerDirection | undefined, referenceTransactionId?: string): WagerOutcome => ({
  type: "process",
  direction,
  referenceTransactionId,
});

describe("BET", () => {
  test("debits", () => {
    expect(evaluate(aTransaction(Kind.Bet))).toEqual(processed(LedgerDirection.Debit));
  });

  test("can spend the exact balance", () => {
    const wallet = aWallet("25.00");
    expect(evaluate(aTransaction(Kind.Bet), { wallet })).toEqual(processed(LedgerDirection.Debit));
  });

  test("is rejected with INSUFFICIENT_FUNDS when short by one cent", () => {
    const wallet = aWallet("24.99");
    expect(evaluate(aTransaction(Kind.Bet), { wallet })).toEqual(rejected(FailureCode.InsufficientFunds));
  });
});

describe("WIN", () => {
  test("credits without a reference", () => {
    expect(evaluate(aTransaction(Kind.Win))).toEqual(processed(LedgerDirection.Credit));
  });

  test("credits even with a zero balance", () => {
    expect(evaluate(aTransaction(Kind.Win), { wallet: aWallet("0.00") })).toEqual(processed(LedgerDirection.Credit));
  });

  const win = (overrides = {}) => aTransaction(Kind.Win, { referenceExternalTransactionId: "ext-ref", ...overrides });

  test("credits with a BET of the same round, resolving the reference", () => {
    expect(evaluate(win(), { reference: aReference(Kind.Bet) })).toEqual(processed(LedgerDirection.Credit, "tx-ref"));
  });

  test("may have an amount different from the BET", () => {
    const transaction = win({ money: brl("500.00") });
    expect(evaluate(transaction, { reference: aReference(Kind.Bet) })).toEqual(
      processed(LedgerDirection.Credit, "tx-ref"),
    );
  });

  test("waits when the reference it names has not arrived", () => {
    expect(evaluate(win())).toEqual(awaiting);
  });

  test("is rejected when it references something other than a BET", () => {
    expect(evaluate(win(), { reference: aReference(Kind.Win) })).toEqual(rejected(FailureCode.ReferenceInvalidKind));
  });

  test("is rejected when the BET was rejected", () => {
    const reference = aReference(Kind.Bet, { status: Status.Rejected });
    expect(evaluate(win(), { reference })).toEqual(rejected(FailureCode.ReferenceNotProcessed));
  });

  test("is rejected on a reference from another round", () => {
    const reference = aReference(Kind.Bet, { roundId: "round-2" });
    expect(evaluate(win(), { reference })).toEqual(rejected(FailureCode.ReferenceMismatch));
  });

  test("is not blocked by referenceAlreadyReversed, which only concerns reversals", () => {
    const outcome = evaluate(win(), { reference: aReference(Kind.Bet), referenceAlreadyReversed: true });
    expect(outcome).toEqual(processed(LedgerDirection.Credit, "tx-ref"));
  });
});

describe("LOSS", () => {
  test("processes with no ledger direction", () => {
    expect(evaluate(aTransaction(Kind.Loss))).toEqual(processed(undefined));
  });

  test("processes with a zero amount", () => {
    expect(evaluate(aTransaction(Kind.Loss, { money: brl("0.00") }))).toEqual(processed(undefined));
  });

  test("processes on an empty wallet, regardless of the amount", () => {
    expect(evaluate(aTransaction(Kind.Loss), { wallet: aWallet("0.00") })).toEqual(processed(undefined));
  });

  const loss = () => aTransaction(Kind.Loss, { referenceExternalTransactionId: "ext-ref" });

  test("resolves a BET reference when it names one", () => {
    expect(evaluate(loss(), { reference: aReference(Kind.Bet) })).toEqual(processed(undefined, "tx-ref"));
  });

  test("waits when the reference it names has not arrived", () => {
    expect(evaluate(loss())).toEqual(awaiting);
  });

  test("is rejected when it references something other than a BET", () => {
    expect(evaluate(loss(), { reference: aReference(Kind.Win) })).toEqual(rejected(FailureCode.ReferenceInvalidKind));
  });
});

describe("REFUND", () => {
  const refund = (overrides = {}) => aTransaction(Kind.Refund, overrides);

  test("credits against a processed BET", () => {
    expect(evaluate(refund(), { reference: aReference(Kind.Bet) })).toEqual(processed(LedgerDirection.Credit, "tx-ref"));
  });

  test("waits when the reference is missing", () => {
    expect(evaluate(refund())).toEqual(awaiting);
  });

  test.each([Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening])("cannot reference %s", (kind) => {
    expect(evaluate(refund(), { reference: aReference(kind) })).toEqual(rejected(FailureCode.ReferenceInvalidKind));
  });

  test.each([Status.Rejected, Status.Failed])("is rejected when the reference is %s", (status) => {
    const reference = aReference(Kind.Bet, { status });
    expect(evaluate(refund(), { reference })).toEqual(rejected(FailureCode.ReferenceNotProcessed));
  });

  test.each([Status.Pending, Status.PendingReference])("waits while the reference is %s", (status) => {
    const reference = aReference(Kind.Bet, { status });
    expect(evaluate(refund(), { reference })).toEqual(awaiting);
  });

  test("can only happen once", () => {
    const outcome = evaluate(refund(), { reference: aReference(Kind.Bet), referenceAlreadyReversed: true });
    expect(outcome).toEqual(rejected(FailureCode.ReferenceAlreadyReversed));
  });

  test.each(["24.99", "25.01"])("is rejected with a partial or larger amount: %s", (amount) => {
    const outcome = evaluate(refund({ money: brl(amount) }), { reference: aReference(Kind.Bet) });
    expect(outcome).toEqual(rejected(FailureCode.AmountMismatch));
  });

  test("is not affected by a low balance, since it credits", () => {
    const outcome = evaluate(refund(), { reference: aReference(Kind.Bet), wallet: aWallet("0.00") });
    expect(outcome).toEqual(processed(LedgerDirection.Credit, "tx-ref"));
  });
});

describe("ROLLBACK", () => {
  const rollback = (overrides = {}) => aTransaction(Kind.Rollback, overrides);

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])("of %s gives the inverse direction %s", (referenceKind, direction) => {
    expect(evaluate(rollback(), { reference: aReference(referenceKind) })).toEqual(processed(direction, "tx-ref"));
  });

  test.each([Kind.Loss, Kind.Rollback, Kind.Opening])("cannot reference %s", (kind) => {
    expect(evaluate(rollback(), { reference: aReference(kind) })).toEqual(rejected(FailureCode.ReferenceInvalidKind));
  });

  test("waits when the reference is missing", () => {
    expect(evaluate(rollback())).toEqual(awaiting);
  });

  test("can only happen once", () => {
    const outcome = evaluate(rollback(), { reference: aReference(Kind.Win), referenceAlreadyReversed: true });
    expect(outcome).toEqual(rejected(FailureCode.ReferenceAlreadyReversed));
  });

  test("is rejected with a different amount", () => {
    const outcome = evaluate(rollback({ money: brl("10.00") }), { reference: aReference(Kind.Bet) });
    expect(outcome).toEqual(rejected(FailureCode.AmountMismatch));
  });

  test.each([Kind.Win, Kind.Refund])(
    "of %s that would make the balance negative uses REVERSAL_INSUFFICIENT_FUNDS, not INSUFFICIENT_FUNDS",
    (kind) => {
      const outcome = evaluate(rollback(), { reference: aReference(kind), wallet: aWallet("24.99") });
      expect(outcome).toEqual(rejected(FailureCode.ReversalInsufficientFunds));
    },
  );

  test("of a WIN can spend the exact balance", () => {
    const outcome = evaluate(rollback(), { reference: aReference(Kind.Win), wallet: aWallet("25.00") });
    expect(outcome).toEqual(processed(LedgerDirection.Debit, "tx-ref"));
  });

  test("of a BET is not affected by a low balance, since it credits", () => {
    const outcome = evaluate(rollback(), { reference: aReference(Kind.Bet), wallet: aWallet("0.00") });
    expect(outcome).toEqual(processed(LedgerDirection.Credit, "tx-ref"));
  });
});

describe("REFERENCE_MISMATCH", () => {
  const mismatches: [string, Partial<WagerTransactionState>][] = [
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["currency", { money: usd("25.00") }],
    ["round", { roundId: "round-2" }],
  ];

  describe.each([Kind.Refund, Kind.Rollback])("%s", (kind) => {
    test.each(mismatches)("when the %s differs", (_label, overrides) => {
      const outcome = evaluate(aTransaction(kind), { reference: aReference(Kind.Bet, overrides) });
      expect(outcome).toEqual(rejected(FailureCode.ReferenceMismatch));
    });
  });

  test("takes precedence over the other reference checks", () => {
    const reference = aReference(Kind.Loss, { roundId: "round-2", status: Status.Rejected, money: brl("1.00") });
    const outcome = evaluate(aTransaction(Kind.Refund), { reference, referenceAlreadyReversed: true });
    expect(outcome).toEqual(rejected(FailureCode.ReferenceMismatch));
  });
});

describe("contract refusals", () => {
  test("CURRENCY_MISMATCH when the operation's currency differs from the wallet's", () => {
    const outcome = evaluate(aTransaction(Kind.Bet, { money: usd("25.00") }));
    expect(outcome).toEqual(rejected(FailureCode.CurrencyMismatch));
  });

  test("CURRENCY_MISMATCH also covers LOSS, which does not move the balance", () => {
    const outcome = evaluate(aTransaction(Kind.Loss, { money: usd("0.00") }));
    expect(outcome).toEqual(rejected(FailureCode.CurrencyMismatch));
  });

  test("PLAYER_MISMATCH when the wallet belongs to another player", () => {
    const outcome = evaluate(aTransaction(Kind.Bet, { playerId: "player-2" }));
    expect(outcome).toEqual(rejected(FailureCode.PlayerMismatch));
  });

  test("KIND_NOT_ALLOWED for OPENING", () => {
    const opening = WagerTransaction.rehydrate({
      ...createProps(Kind.Opening),
      payloadHash: "h",
      status: Status.Pending,
      attempts: 0,
    });
    expect(evaluate(opening)).toEqual(rejected(FailureCode.KindNotAllowed));
  });
});

describe("programming errors", () => {
  test.each([Status.Processed, Status.Rejected, Status.Failed])("throws for a transaction already %s", (status) => {
    expect(() => evaluate(aFinished(status))).toThrow(InvalidTransactionStateError);
  });

  test("throws when given another wallet", () => {
    const wallet = aWallet("100.00", { id: "wallet-2" });
    expect(() => evaluate(aTransaction(Kind.Bet), { wallet })).toThrow(InvalidTransactionStateError);
  });
});

describe("references out of order", () => {
  test("keeps waiting until the 9th retry", () => {
    expect(evaluate(aPendingReference(Kind.Refund, MAX_REFERENCE_ATTEMPTS - 2))).toEqual(awaiting);
  });

  test("gives up on the 10th retry with REFERENCE_NOT_FOUND", () => {
    expect(evaluate(aPendingReference(Kind.Refund, MAX_REFERENCE_ATTEMPTS - 1))).toEqual(
      rejected(FailureCode.ReferenceNotFound),
    );
  });

  test("gives up with REFERENCE_NOT_PROCESSED when the reference never finishes", () => {
    const reference = aReference(Kind.Bet, { status: Status.PendingReference });
    expect(evaluate(aPendingReference(Kind.Refund, MAX_REFERENCE_ATTEMPTS - 1), { reference })).toEqual(
      rejected(FailureCode.ReferenceNotProcessed),
    );
  });

  test("a reference that arrives on the last retry still wins", () => {
    const outcome = evaluate(aPendingReference(Kind.Refund, MAX_REFERENCE_ATTEMPTS - 1), {
      reference: aReference(Kind.Bet),
    });
    expect(outcome).toEqual(processed(LedgerDirection.Credit, "tx-ref"));
  });

  test("runs exactly 10 retries over the documented backoff, then rejects", () => {
    const transaction = aTransaction(Kind.Rollback);
    let now = AT;
    transaction.markPendingReference(now);

    let retries = 0;
    let waitedMs = backoffDelayMs(1);
    for (;;) {
      now = transaction.nextAttemptAt as Date;
      retries += 1;
      const outcome = evaluate(transaction);
      if (outcome.type !== "await-reference") {
        expect<WagerOutcome>(outcome).toEqual(rejected(FailureCode.ReferenceNotFound));
        transaction.reject(FailureCode.ReferenceNotFound, brl("100.00"));
        break;
      }
      transaction.markPendingReference(now);
      waitedMs += backoffDelayMs(transaction.attempts + 1);
    }

    expect(retries).toBe(10);
    expect(waitedMs).toBe((1 + 2 + 4 + 8 + 16 + 32 + 60 * 4) * 1000);
    expect(transaction.status).toBe(Status.Rejected);
  });
});

describe("the policy is pure", () => {
  test("does not change the transaction, the wallet or the reference", () => {
    const transaction = aTransaction(Kind.Rollback);
    const wallet = aWallet("100.00");
    const reference = aReference(Kind.Win);

    evaluate(transaction, { wallet, reference });

    expect(transaction.status).toBe(Status.Pending);
    expect(wallet.balance.equals(brl("100.00"))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(reference.status).toBe(Status.Processed);
  });

  test("gives the same answer every time", () => {
    const transaction = aTransaction(Kind.Bet);
    expect(evaluate(transaction)).toEqual(evaluate(transaction));
  });
});

describe("mandatory scenario, applied in sequence", () => {
  test("of two 80.00 bets on 100.00, one is processed and one is rejected", () => {
    const wallet = aWallet("100.00");
    const results = ["a", "b"].map((id) => {
      const bet = aTransaction(Kind.Bet, { id, money: brl("80.00") });
      const outcome = evaluateWagerPolicy({
        transaction: bet,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
      });
      if (outcome.type === "process") {
        wallet.debit({ entryId: `entry-${id}`, transactionId: id, money: bet.money, at: LATER });
        bet.markProcessed(undefined, LATER, wallet.balance);
      } else if (outcome.type === "reject") {
        bet.reject(outcome.failureCode, wallet.balance);
      }
      return bet;
    });

    expect(results.map((bet) => bet.status)).toEqual([Status.Processed, Status.Rejected]);
    expect(results[1]?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(results[0]?.balanceAfter?.equals(brl("20.00"))).toBe(true);
    expect(results[1]?.balanceAfter?.equals(brl("20.00"))).toBe(true);
    expect(wallet.balance.equals(brl("20.00"))).toBe(true);
    expect(wallet.version).toBe(2);
  });
});

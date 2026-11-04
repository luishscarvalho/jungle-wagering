import { describe, expect, test } from "bun:test";
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../src/domain/ledger/wallet-ledger-entry";
import { InvalidLedgerEntryError, UnbalancedLedgerEntryError } from "../../../src/domain/ledger/wallet-ledger-entry.errors";
import { CurrencyMismatchError } from "../../../src/domain/money/money.errors";
import { AT, brl, usd } from "./fixtures";

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("25.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    createdAt: AT,
    ...overrides,
  };
}

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced debit", () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
  });

  test("accepts a balanced credit", () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl("75.00"), balanceAfter: brl("100.00") }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test("accepts a debit down to zero", () => {
    expect(WalletLedgerEntry.create(props({ balanceBefore: brl("25.00"), balanceAfter: brl("0.00") })).isBalanced()).toBe(
      true,
    );
  });

  test.each([
    ["debit off by one cent", LedgerDirection.Debit, "100.00", "75.01"],
    ["debit that credited", LedgerDirection.Debit, "100.00", "125.00"],
    ["credit off by one cent", LedgerDirection.Credit, "100.00", "124.99"],
    ["credit that debited", LedgerDirection.Credit, "100.00", "75.00"],
    ["no movement", LedgerDirection.Debit, "100.00", "100.00"],
  ])("rejects an unbalanced entry: %s", (_label, direction, before, after) => {
    expect(() =>
      WalletLedgerEntry.create(props({ direction, balanceBefore: brl(before), balanceAfter: brl(after) })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test.each([
    ["money", { money: usd("25.00") }],
    ["balanceBefore", { balanceBefore: usd("100.00") }],
    ["balanceAfter", { balanceAfter: usd("75.00") }],
  ])("rejects a different currency in %s", (_label, overrides) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow(CurrencyMismatchError);
  });

  test.each([
    ["zero", brl("0.00")],
    ["negative", brl("25.00").negate()],
  ])("rejects a %s amount", (_label, money) => {
    expect(() => WalletLedgerEntry.create(props({ money }))).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a negative balance, even with correct arithmetic", () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceBefore: brl("10.00"), balanceAfter: brl("15.00").negate() })),
    ).toThrow(InvalidLedgerEntryError);
  });
});

describe("immutability", () => {
  test("is frozen, with no way to change a field", () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = "CREDIT";
    }).toThrow(TypeError);
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("rebuilds without revalidating, and isBalanced reveals corrupted data", () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("1.00") }));
    expect(entry.balanceAfter.equals(brl("1.00"))).toBe(true);
    expect(entry.isBalanced()).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { LedgerDirection, type WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { InvalidLedgerEntryError } from "../../../src/domain/ledger/wallet-ledger-entry.errors";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError } from "../../../src/domain/money/money.errors";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { InsufficientFundsError, InvalidWalletOperationError } from "../../../src/domain/wallet/wallet.errors";
import { AT, aWallet, brl, LATER, usd } from "./fixtures";

const movement = (money: Money, entryId = "entry-1") => ({ entryId, transactionId: "tx-1", money, at: LATER });

function assertUntouched(wallet: Wallet, balance: string, version: number): void {
  expect(wallet.balance.equals(brl(balance))).toBe(true);
  expect(wallet.version).toBe(version);
  expect(wallet.updatedAt).toEqual(AT);
}

describe("Wallet.open", () => {
  test("starts at version 1 with the initial balance", () => {
    const wallet = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1000.00"), at: AT });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.equals(brl("1000.00"))).toBe(true);
    expect(wallet.createdAt).toEqual(AT);
    expect(wallet.updatedAt).toEqual(AT);
  });

  test("accepts a zero balance", () => {
    expect(Wallet.open({ id: "w", playerId: "p", initialBalance: brl("0.00"), at: AT }).balance.isZero()).toBe(true);
  });

  test("rejects a negative balance", () => {
    const initialBalance = Money.fromMinor(-1n, "BRL");
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance, at: AT })).toThrow(InvalidWalletOperationError);
  });
});

describe("Wallet.rehydrate", () => {
  test("restores state as stored, without touching version", () => {
    const wallet = aWallet("10.00", { version: 7 });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.equals(brl("10.00"))).toBe(true);
  });
});

describe("debit", () => {
  test("lowers the balance, bumps version and returns the entry", () => {
    const wallet = aWallet("100.00");
    const entry = wallet.debit(movement(brl("25.00")));

    expect(wallet.balance.equals(brl("75.00"))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry).toMatchObject({
      id: "entry-1",
      walletId: wallet.id,
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      createdAt: LATER,
    });
    expect(entry.balanceBefore.equals(brl("100.00"))).toBe(true);
    expect(entry.balanceAfter.equals(brl("75.00"))).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test("allows spending the whole balance", () => {
    const wallet = aWallet("25.00");
    wallet.debit(movement(brl("25.00")));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("throws InsufficientFundsError and leaves the wallet untouched", () => {
    const wallet = aWallet("25.00");
    expect(() => wallet.debit(movement(brl("25.01")))).toThrow(InsufficientFundsError);
    assertUntouched(wallet, "25.00", 1);
  });

  test("throws CurrencyMismatchError and leaves the wallet untouched", () => {
    const wallet = aWallet("100.00");
    expect(() => wallet.debit(movement(usd("1.00")))).toThrow(CurrencyMismatchError);
    assertUntouched(wallet, "100.00", 1);
  });

  test.each([
    ["zero", brl("0.00")],
    ["negative", brl("1.00").negate()],
  ])("rejects a %s amount, leaving the wallet untouched", (_label, money) => {
    const wallet = aWallet("100.00");
    expect(() => wallet.debit(movement(money))).toThrow(InvalidLedgerEntryError);
    assertUntouched(wallet, "100.00", 1);
  });
});

describe("credit", () => {
  test("raises the balance, bumps version and returns the entry", () => {
    const wallet = aWallet("100.00");
    const entry = wallet.credit(movement(brl("25.00")));

    expect(wallet.balance.equals(brl("125.00"))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  test("throws CurrencyMismatchError and leaves the wallet untouched", () => {
    const wallet = aWallet("100.00");
    expect(() => wallet.credit(movement(usd("1.00")))).toThrow(CurrencyMismatchError);
    assertUntouched(wallet, "100.00", 1);
  });

  test.each([
    ["zero", brl("0.00")],
    ["negative", brl("1.00").negate()],
  ])("rejects a %s amount, so it cannot act as a hidden debit", (_label, money) => {
    const wallet = aWallet("100.00");
    expect(() => wallet.credit(movement(money))).toThrow(InvalidLedgerEntryError);
    assertUntouched(wallet, "100.00", 1);
  });
});

describe("openingLedgerEntry", () => {
  test("credits from zero to the initial balance, keeping version at 1", () => {
    const wallet = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1000.00"), at: AT });
    const entry = wallet.openingLedgerEntry({ entryId: "e", transactionId: "t", at: AT });

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.isZero()).toBe(true);
    expect(entry.balanceAfter.equals(brl("1000.00"))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.equals(brl("1000.00"))).toBe(true);
  });

  test("rejects a wallet opened with zero, which has nothing to record", () => {
    const wallet = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("0.00"), at: AT });
    expect(() => wallet.openingLedgerEntry({ entryId: "e", transactionId: "t", at: AT })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("rejects a wallet that already moved", () => {
    const wallet = aWallet("100.00");
    wallet.credit(movement(brl("1.00")));
    expect(() => wallet.openingLedgerEntry({ entryId: "e", transactionId: "t", at: AT })).toThrow(
      InvalidWalletOperationError,
    );
  });
});

describe("balance and ledger stay consistent", () => {
  test("the balance equals the one rebuilt from the entries", () => {
    const wallet = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("100.00"), at: AT });
    const entries: WalletLedgerEntry[] = [wallet.openingLedgerEntry({ entryId: "e0", transactionId: "t0", at: AT })];

    entries.push(wallet.debit(movement(brl("30.00"), "e1")));
    entries.push(wallet.credit(movement(brl("5.50"), "e2")));
    entries.push(wallet.debit(movement(brl("0.01"), "e3")));

    const rebuilt = entries.reduce(
      (balance, entry) => (entry.direction === LedgerDirection.Credit ? balance.add(entry.money) : balance.subtract(entry.money)),
      Money.zero("BRL"),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.equals(brl("75.49"))).toBe(true);
    expect(wallet.version).toBe(4);
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
  });

  test("each entry starts where the previous one ended", () => {
    const wallet = aWallet("100.00");
    const first = wallet.debit(movement(brl("10.00"), "e1"));
    const second = wallet.debit(movement(brl("10.00"), "e2"));
    expect(second.balanceBefore.equals(first.balanceAfter)).toBe(true);
  });
});

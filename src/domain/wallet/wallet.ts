import { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { CurrencyMismatchError } from "../money/money.errors";
import { InsufficientFundsError, InvalidWalletOperationError } from "./wallet.errors";

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  private _balance: Money;
  private _version: number;
  private _updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.balance.currency;
    this.createdAt = state.createdAt;
    this._balance = state.balance;
    this._version = state.version;
    this._updatedAt = state.updatedAt;
  }

  /** A positive initial balance also needs openingLedgerEntry, which keeps version at 1. */
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError("Initial balance cannot be negative");
    }
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(movement.money), movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  /** The entry for the balance set by open(). It does not change the balance or version. */
  openingLedgerEntry(props: { entryId: string; transactionId: string; at: Date }): WalletLedgerEntry {
    if (this._version !== 1) {
      throw new InvalidWalletOperationError("Opening entry only applies to a wallet that has not moved");
    }
    return WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: props.at,
    });
  }

  private apply(direction: LedgerDirection, balanceAfter: Money, movement: WalletMovement): WalletLedgerEntry {
    // The entry validates first, so a rejected movement leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

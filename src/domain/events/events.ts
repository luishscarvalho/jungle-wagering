import type { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { Money, MoneyProps } from "../money/money";
import type { FailureCode } from "../shared/failure-code";
import { InvalidTransactionStateError } from "../transaction/wager-transaction.errors";
import { type WagerTransaction, WagerTransactionStatus } from "../transaction/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import { type EventContext, IntegrationEvent } from "./integration-event";

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
}

function transactionData(transaction: WagerTransaction): TransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new InvalidTransactionStateError(`Event requires ${expected}, transaction is ${transaction.status}`);
  }
}

function requireBalanceAfter(transaction: WagerTransaction): Money {
  if (!transaction.balanceAfter) {
    throw new InvalidTransactionStateError(`${transaction.status} transaction has no balanceAfter`);
  }
  return transaction.balanceAfter;
}

export interface WagerTransactionProcessedData extends TransactionData {
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    const { referenceTransactionId } = transaction;
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        balanceAfter: requireBalanceAfter(transaction).toJSON(),
        ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
  balanceAfter: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    if (!transaction.failureCode) {
      throw new InvalidTransactionStateError("REJECTED transaction has no failureCode");
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        failureCode: transaction.failureCode,
        balanceAfter: requireBalanceAfter(transaction).toJSON(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    const { referenceExternalTransactionId, nextAttemptAt } = transaction;
    if (!referenceExternalTransactionId || !nextAttemptAt) {
      throw new InvalidTransactionStateError("PENDING_REFERENCE needs a reference and a next attempt");
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceExternalTransactionId,
        attempts: transaction.attempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

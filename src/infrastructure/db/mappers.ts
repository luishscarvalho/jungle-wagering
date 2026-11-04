import { type LedgerDirection, WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import type { FailureCode } from "../../domain/shared/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/transaction/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "./schemas";

const NUMERIC_PATTERN = /^(-?)(\d+)\.(\d{2})$/;

/** Exact text to cents. Accepts negatives, unlike Money.from, for reconciliation differences. */
export function moneyFromColumn(value: string, currency: string): Money {
  const match = NUMERIC_PATTERN.exec(value);
  if (!match) throw new Error("Stored amount does not have scale 2");
  const minor = BigInt(`${match[2]}${match[3]}`);
  return Money.fromMinor(match[1] ? -minor : minor, currency);
}

export function moneyToColumn(money: Money): string {
  return money.toJSON().amount;
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: moneyToColumn(wallet.balance),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: moneyFromColumn(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function transactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: moneyToColumn(transaction.money),
    currency: transaction.money.currency,
    status: transaction.status,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    balanceAfter: transaction.balanceAfter ? moneyToColumn(transaction.balanceAfter) : null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

export function transactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: moneyFromColumn(record.amount, record.currency),
    status: record.status as WagerTransactionStatus,
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode as FailureCode | null) ?? undefined,
    balanceAfter: record.balanceAfter === null ? undefined : moneyFromColumn(record.balanceAfter, record.currency),
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    createdAt: record.createdAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: moneyToColumn(entry.money),
    balanceBefore: moneyToColumn(entry.balanceBefore),
    balanceAfter: moneyToColumn(entry.balanceAfter),
    createdAt: entry.createdAt,
  };
}

/** The ledger table has no currency column: it belongs to the wallet. */
export function ledgerEntryFromRecord(record: WalletLedgerEntryRecord, currency: string): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: moneyFromColumn(record.amount, currency),
    balanceBefore: moneyFromColumn(record.balanceBefore, currency),
    balanceAfter: moneyFromColumn(record.balanceAfter, currency),
    createdAt: record.createdAt,
  });
}

export function inboxMessageToRecord(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function inboxMessageFromRecord(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function outboxMessageToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
  };
}

export function outboxMessageFromRecord(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    publishedAt: record.publishedAt ?? undefined,
  });
}

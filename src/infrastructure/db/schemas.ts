import { EntitySchema } from "@mikro-orm/core";

// Rows as stored. Domain classes stay free of ORM concerns, and mappers.ts converts
// between the two. Money columns are strings, so no value passes through a number.

const money = { type: "decimal", precision: 20, scale: 2 } as const;
const moneyNullable = { ...money, nullable: true } as const;
const timestamp = { type: "datetime", columnType: "timestamptz" } as const;
const timestampNullable = { ...timestamp, nullable: true } as const;
const text = { type: "text" } as const;
const textNullable = { type: "text", nullable: true } as const;
const uuid = { type: "uuid" } as const;
const currency = { type: "character", columnType: "char(3)" } as const;

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: { ...uuid, primary: true },
    playerId: uuid,
    currency,
    balance: money,
    version: { type: "integer" },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  balanceAfter: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: { ...uuid, primary: true },
    providerId: text,
    externalTransactionId: text,
    idempotencyKey: text,
    payloadHash: text,
    walletId: uuid,
    playerId: uuid,
    roundId: text,
    gameId: text,
    kind: text,
    amount: money,
    currency,
    status: text,
    referenceExternalTransactionId: textNullable,
    referenceTransactionId: { ...uuid, nullable: true },
    failureCode: textNullable,
    balanceAfter: moneyNullable,
    attempts: { type: "integer" },
    nextAttemptAt: timestampNullable,
    createdAt: timestamp,
    processedAt: timestampNullable,
  },
});

export interface WalletLedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { ...uuid, primary: true },
    walletId: uuid,
    transactionId: uuid,
    direction: text,
    amount: money,
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamp,
  },
});

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: { ...text, primary: true },
    messageId: { ...text, primary: true },
    payloadHash: text,
    receivedAt: timestamp,
    processedAt: timestampNullable,
  },
});

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: { ...uuid, primary: true },
    aggregateId: uuid,
    eventType: text,
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: timestamp,
    attempts: { type: "integer" },
    nextAttemptAt: timestamp,
    publishedAt: timestampNullable,
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];

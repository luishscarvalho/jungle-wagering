import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../domain/messaging/inbox-message";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import type { Money } from "../domain/money/money";
import type { WagerTransaction } from "../domain/transaction/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** Locks the row until the surrounding transaction ends. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** @throws DuplicateWalletError */
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK already points at this transaction. */
  isReversed(transactionId: string): Promise<boolean>;
  /** @throws DuplicateTransactionError */
  insert(transaction: WagerTransaction): Promise<void>;
}

export interface WalletReconciliationSnapshot {
  stored: Money;
  calculated: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Oldest first, starting right after afterId. Currency is the wallet's, as entries do not store it. */
  listPage(walletId: string, currency: string, afterId: string | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** Stored and calculated balances from one snapshot, so they are comparable without a lock. */
  reconciliationSnapshot(walletId: string): Promise<WalletReconciliationSnapshot | undefined>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
  /** False when this consumer already recorded the message. Waits for a concurrent insert to finish. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWork {
  /** Runs work in one SQL transaction: it commits when work resolves and rolls back when it rejects. */
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Repositories for reads outside a transaction. */
  reader(): Repositories;
}

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export interface AppLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const CLOCK = Symbol("CLOCK");
export const APP_LOGGER = Symbol("APP_LOGGER");

/** Lost the race for (idempotency_key) or for (provider_id, external_transaction_id). */
export class DuplicateTransactionError extends Error {
  override readonly name = "DuplicateTransactionError";
}

/** Lost the race for (player_id, currency). */
export class DuplicateWalletError extends Error {
  override readonly name = "DuplicateWalletError";
}

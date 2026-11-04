import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../domain/messaging/inbox-message";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import type { Money } from "../domain/money/money";
import type { FailureCode } from "../domain/shared/failure-code";
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/transaction/wager-transaction";
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
  update(transaction: WagerTransaction): Promise<void>;
  /** Takes no lock: the caller locks the wallet first, in a transaction of its own. */
  findDuePendingReferences(limit: number): Promise<DuePendingReference[]>;
  /** Locks the row and returns it only if it is still PENDING_REFERENCE and due. Call with the wallet locked. */
  lockIfDuePendingReference(id: string): Promise<WagerTransaction | undefined>;
  /**
   * Makes the PENDING_REFERENCE rows waiting on this external id due now. Limited to the
   * wallet whose lock the caller holds, to keep the lock order. Rows of other wallets
   * can only end as REFERENCE_MISMATCH, so they lose nothing by waiting for their backoff.
   */
  wakeWaitingFor(reference: { providerId: string; externalTransactionId: string; walletId: string }): Promise<void>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
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
  /**
   * Locks due messages, in order, skipping rows other publishers hold. An aggregate only
   * enters the batch through its oldest unpublished message, so no publisher can overtake
   * another one, or a message waiting for its backoff, on the same aggregate.
   */
  lockDueBatch(limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
  /** Age of the oldest unpublished message, 0 when there is none. */
  oldestPendingAgeSeconds(): Promise<number>;
}

export interface InboxRepository {
  /** False when this consumer already recorded the message. Waits for a concurrent insert to finish. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
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

export interface EventPublisher {
  /** At-least-once: consumers deduplicate by eventId, which is the message id. */
  publish(message: OutboxMessage): Promise<void>;
}

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export interface AppLogger {
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

export type ProcessingEntry = "http" | "sqs" | "pending";
export type DuplicateSource = "http_replay" | "sqs_replay" | "inbox";
export type RetrySource = "sqs" | "outbox" | "pending";
export type LockConflictKind = "lock_timeout" | "deadlock" | "unique_race";

/** Called after the commit, so a rollback is never counted as an outcome. */
export interface Metrics {
  /** A transaction entered this status. One transaction can count more than once: PENDING_REFERENCE, then PROCESSED. */
  transactionRecorded(status: WagerTransactionStatus, kind: WagerTransactionKind): void;
  /** Refused with no transaction written, which transactionRecorded does not see. */
  refused(failureCode: FailureCode): void;
  duplicateDetected(source: DuplicateSource): void;
  /** The work was put back to run again. */
  retryScheduled(source: RetrySource): void;
  deadLettered(reason: string): void;
  lockConflict(kind: LockConflictKind): void;
  processingObserved(entry: ProcessingEntry, seconds: number): void;
  reconciliationDivergence(): void;
}

/** Whether an error is worth retrying as is. Lives behind a function because the answer depends on the driver. */
export type TransientErrorClassifier = (error: unknown) => boolean;

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const CLOCK = Symbol("CLOCK");
export const APP_LOGGER = Symbol("APP_LOGGER");
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");
export const METRICS = Symbol("METRICS");

/** Lost the race for (idempotency_key) or for (provider_id, external_transaction_id). */
export class DuplicateTransactionError extends Error {
  override readonly name = "DuplicateTransactionError";
}

/** Lost the race for (player_id, currency). */
export class DuplicateWalletError extends Error {
  override readonly name = "DuplicateWalletError";
}

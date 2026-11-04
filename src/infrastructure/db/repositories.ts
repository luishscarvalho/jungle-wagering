import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
  DuplicateTransactionError,
  DuplicateWalletError,
  type DuePendingReference,
  type InboxRepository,
  type LedgerRepository,
  type OutboxRepository,
  type Repositories,
  type WagerTransactionRepository,
  type WalletReconciliationSnapshot,
  type WalletRepository,
} from "../../application/ports";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import {
  inboxMessageFromRecord,
  inboxMessageToRecord,
  outboxMessageFromRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  moneyFromColumn,
  moneyToColumn,
  outboxMessageToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from "./mappers";
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from "./schemas";

const WALLET_DUPLICATE_CONSTRAINT = "wallets_player_currency_unique";
const TRANSACTION_DUPLICATE_CONSTRAINTS = [
  "wager_transactions_idempotency_key_unique",
  "wager_transactions_provider_external_unique",
];

function uuidArray(ids: string[]): string {
  return `{${ids.join(",")}}`;
}

function violatedUniqueConstraint(error: unknown): string | undefined {
  if (!(error instanceof UniqueConstraintViolationException)) return undefined;
  return (error as unknown as { constraint?: string }).constraint;
}

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record ? walletFromRecord(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletFromRecord(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, walletToRecord(wallet));
    } catch (error) {
      if (violatedUniqueConstraint(error) === WALLET_DUPLICATE_CONSTRAINT) throw new DuplicateWalletError();
      throw error;
    }
  }

  async update(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id },
      { balance: moneyToColumn(wallet.balance), version: wallet.version, updatedAt: wallet.updatedAt },
    );
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id });
    return record ? transactionFromRecord(record) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { idempotencyKey });
    return record ? transactionFromRecord(record) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId });
    return record ? transactionFromRecord(record) : undefined;
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId: transactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionSchema, transactionToRecord(transaction));
    } catch (error) {
      const constraint = violatedUniqueConstraint(error);
      if (constraint && TRANSACTION_DUPLICATE_CONSTRAINTS.includes(constraint)) {
        throw new DuplicateTransactionError();
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const record = transactionToRecord(transaction);
    await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        balanceAfter: record.balanceAfter,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        processedAt: record.processedAt,
      },
    );
  }

  async findDuePendingReferences(limit: number): Promise<DuePendingReference[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `SELECT id, wallet_id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
        ORDER BY next_attempt_at, id
        LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }

  async lockIfDuePendingReference(id: string): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<{ id: string }[]>(
      `SELECT id FROM wager_transactions
        WHERE id = ? AND status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
        FOR UPDATE`,
      [id],
    );
    return rows.length > 0 ? this.findById(id) : undefined;
  }

  async wakeWaitingFor(reference: { providerId: string; externalTransactionId: string; walletId: string }): Promise<void> {
    await this.em.execute(
      `UPDATE wager_transactions SET next_attempt_at = now()
        WHERE status = 'PENDING_REFERENCE'
          AND provider_id = ?
          AND reference_external_transaction_id = ?
          AND wallet_id = ?
          AND next_attempt_at > now()`,
      [reference.providerId, reference.externalTransactionId, reference.walletId],
    );
  }
}

interface ReconciliationRow {
  stored: string;
  calculated: string;
  entries: string;
  currency: string;
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(WalletLedgerEntrySchema, ledgerEntryToRecord(entry));
  }

  async listPage(
    walletId: string,
    currency: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      WalletLedgerEntrySchema,
      afterId ? { walletId, id: { $gt: afterId } } : { walletId },
      { orderBy: { id: "asc" }, limit },
    );
    return records.map((record) => ledgerEntryFromRecord(record, currency));
  }

  // One statement, so stored and calculated come from the same snapshot even under
  // READ COMMITTED, with no lock on what may be a hot wallet.
  async reconciliationSnapshot(walletId: string): Promise<WalletReconciliationSnapshot | undefined> {
    const rows = await this.em.execute<ReconciliationRow[]>(
      `SELECT w.balance::text AS stored,
              w.currency AS currency,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(30,2)::text AS calculated,
              COUNT(l.id)::text AS entries
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      stored: moneyFromColumn(row.stored, row.currency),
      calculated: moneyFromColumn(row.calculated, row.currency),
      checkedEntries: Number(row.entries),
    };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, outboxMessageToRecord(message));
  }

  async lockDueBatch(limit: number): Promise<OutboxMessage[]> {
    const heads = await this.em.execute<{ id: string; aggregate_id: string }[]>(
      `SELECT m.id, m.aggregate_id FROM outbox_messages m
        WHERE m.published_at IS NULL AND m.next_attempt_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM outbox_messages earlier
             WHERE earlier.aggregate_id = m.aggregate_id
               AND earlier.published_at IS NULL
               AND (earlier.occurred_at, earlier.id) < (m.occurred_at, m.id)
          )
        ORDER BY m.occurred_at, m.id
        FOR UPDATE OF m SKIP LOCKED
        LIMIT ?`,
      [limit],
    );
    if (heads.length === 0) return [];

    // Holding the head makes the rest of its aggregate exclusive to this publisher,
    // since no other one can select a message that has an older one unpublished.
    const room = limit - heads.length;
    const followers =
      room === 0
        ? []
        : await this.em.execute<{ id: string }[]>(
            `SELECT id FROM outbox_messages
              WHERE aggregate_id = ANY(?::uuid[])
                AND id <> ALL(?::uuid[])
                AND published_at IS NULL AND next_attempt_at <= now()
              ORDER BY occurred_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT ?`,
            [uuidArray(heads.map((head) => head.aggregate_id)), uuidArray(heads.map((head) => head.id)), room],
          );

    const ids = [...heads, ...followers].map((row) => row.id);
    const records = await this.em.find(
      OutboxMessageSchema,
      { id: { $in: ids } },
      { orderBy: { occurredAt: "asc", id: "asc" } },
    );
    return records.map(outboxMessageFromRecord);
  }

  async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt, publishedAt: message.publishedAt ?? null },
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const [row] = await this.em.execute<{ age: string | number }[]>(
      `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float8 AS age
         FROM outbox_messages
        WHERE published_at IS NULL`,
    );
    return Math.max(0, Number(row?.age ?? 0));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxMessageSchema)
      .insert(inboxMessageToRecord(message))
      .onConflict(["consumerName", "messageId"])
      .ignore()
      .execute("run");
    return result.affectedRows > 0;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId });
    return record ? inboxMessageFromRecord(record) : undefined;
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}

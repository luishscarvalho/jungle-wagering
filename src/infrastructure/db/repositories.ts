import { LockMode, UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
  DuplicateTransactionError,
  DuplicateWalletError,
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
  inboxMessageToRecord,
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

import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from "../../domain/events/events";
import type { EventContext, IntegrationEvent } from "../../domain/events/integration-event";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { evaluateWagerPolicy } from "../../domain/policy/wager-policy";
import type { BackoffPolicy } from "../../domain/shared/backoff";
import { FailureCategory, type FailureCode, failureCategoryOf } from "../../domain/shared/failure-code";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { Clock, IdGenerator, Repositories } from "../ports";

export interface SettleInput {
  transaction: WagerTransaction;
  /** Locked by the caller, in the transaction that `repositories` belongs to. */
  wallet: Wallet;
  repositories: Repositories;
  correlationId?: string;
  causationId?: string;
  /** Insert on first arrival, update on a retry. Runs before the ledger, which points at the row. */
  save: () => Promise<void>;
}

export type Settlement = { type: "settled" } | { type: "refused"; failureCode: FailureCode };

/** Applies the policy's decision: balance, ledger, transaction and outbox. Shared by the entries and the worker. */
export class WagerSettlement {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly referenceBackoff?: BackoffPolicy,
  ) {}

  async settle(input: SettleInput): Promise<Settlement> {
    const { transaction, wallet, repositories } = input;
    const reference = transaction.referenceExternalTransactionId
      ? await repositories.transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        )
      : undefined;
    const outcome = evaluateWagerPolicy({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: reference ? await repositories.transactions.isReversed(reference.id) : false,
    });

    const now = this.clock.now();
    const events: IntegrationEvent<unknown>[] = [];
    let entry: WalletLedgerEntry | undefined;

    if (outcome.type === "process") {
      if (outcome.direction) entry = this.moveBalance(wallet, transaction, outcome.direction, now);
      transaction.markProcessed(outcome.referenceTransactionId, now, wallet.balance);
      events.push(WagerTransactionProcessed.from(transaction, this.eventContext(input, now)));
      if (entry) events.push(WalletBalanceChanged.from(wallet, entry, this.eventContext(input, now)));
    } else if (outcome.type === "await-reference") {
      // Announced once, on arrival. Each retry would only repeat that the reference is missing.
      const alreadyWaiting = transaction.status === WagerTransactionStatus.PendingReference;
      transaction.markPendingReference(now, this.referenceBackoff);
      if (!alreadyWaiting) {
        events.push(WagerTransactionPendingReference.from(transaction, this.eventContext(input, now)));
      }
    } else {
      if (failureCategoryOf(outcome.failureCode) !== FailureCategory.Business) {
        return { type: "refused", failureCode: outcome.failureCode };
      }
      transaction.reject(outcome.failureCode, wallet.balance);
      events.push(WagerTransactionRejected.from(transaction, this.eventContext(input, now)));
    }

    await input.save();
    if (entry) {
      await repositories.ledger.insert(entry);
      await repositories.wallets.update(wallet);
    }
    // Whoever waits for this one now has an answer either way: apply, or reject as REFERENCE_NOT_PROCESSED.
    if (transaction.isTerminal()) {
      await repositories.transactions.wakeWaitingFor({
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
      });
    }
    for (const event of events) await repositories.outbox.insert(OutboxMessage.enqueue(event));

    return { type: "settled" };
  }

  private moveBalance(
    wallet: Wallet,
    transaction: WagerTransaction,
    direction: LedgerDirection,
    at: Date,
  ): WalletLedgerEntry {
    // The id is generated under the wallet lock, so ids of one wallet follow commit
    // order (up to clock differences between instances) and a cursor reader does not
    // miss an entry committed behind its position.
    const movement = { entryId: this.ids.next(), transactionId: transaction.id, money: transaction.money, at };
    return direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  }

  private eventContext(input: SettleInput, occurredAt: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: input.correlationId ?? input.transaction.idempotencyKey,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      occurredAt,
    };
  }
}

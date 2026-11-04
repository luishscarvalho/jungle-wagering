import { FailureCode } from "../../domain/shared/failure-code";
import type { BackoffPolicy } from "../../domain/shared/backoff";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/transaction/wager-transaction";
import type {
  AppLogger,
  Clock,
  DuePendingReference,
  IdGenerator,
  Metrics,
  TransientErrorClassifier,
  UnitOfWork,
} from "../ports";
import { WagerSettlement } from "./wager-settlement";

const BATCH_SIZE = 50;

function describeError(error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

/** Retries transactions waiting for their reference. Safe to run in any number of instances. */
export class ProcessPendingReferences {
  private readonly settlement: WagerSettlement;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    ids: IdGenerator,
    clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly isTransient: TransientErrorClassifier,
    backoff?: BackoffPolicy,
  ) {
    this.settlement = new WagerSettlement(ids, clock, backoff);
  }

  /** Returns whether it is worth running again right away. */
  async runRound(): Promise<boolean> {
    const due = await this.unitOfWork.reader().transactions.findDuePendingReferences(BATCH_SIZE);

    let progressed = 0;
    for (const item of due) {
      const startedAt = performance.now();
      try {
        const retried = await this.retry(item);
        if (retried) {
          progressed += 1;
          this.record(retried);
        }
      } catch (error) {
        if (await this.handleFailure(item, error)) progressed += 1;
      } finally {
        this.metrics.processingObserved("pending", (performance.now() - startedAt) / 1000);
      }
    }
    return progressed > 0;
  }

  /** Each one in its own transaction, so a hot or failing wallet does not hold back the others. */
  private retry({ id, walletId }: DuePendingReference): Promise<WagerTransaction | undefined> {
    return this.unitOfWork.transaction(async (repositories) => {
      // Wallet first, as everywhere: this is what serializes it with the API and the consumer.
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      // Another instance may have handled it since the selection, so this revalidates under lock.
      const transaction = await repositories.transactions.lockIfDuePendingReference(id);
      if (!wallet || !transaction) return undefined;

      const settled = await this.settlement.settle({
        transaction,
        wallet,
        repositories,
        save: () => repositories.transactions.update(transaction),
      });
      if (settled.type === "refused") {
        // The schema's foreign keys rule out the contract codes for a stored transaction.
        throw new Error(`Stored transaction refused with ${settled.failureCode}`);
      }

      this.logger.info("Pending reference retried", {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        correlationId: transaction.idempotencyKey,
        status: transaction.status,
        failureCode: transaction.failureCode,
        attempts: transaction.attempts,
      });
      return transaction;
    });
  }

  private record(transaction: WagerTransaction): void {
    if (transaction.status === WagerTransactionStatus.PendingReference) this.metrics.retryScheduled("pending");
    else this.metrics.transactionRecorded(transaction.status, transaction.kind);
  }

  /** The attempt rolled back. Returns whether the transaction ended as FAILED. */
  private async handleFailure(item: DuePendingReference, error: unknown): Promise<boolean> {
    const context = { transactionId: item.id, walletId: item.walletId, ...describeError(error) };

    if (this.isTransient(error)) {
      // Attempts are untouched: an outage must not use up the wait for a reference. It stays due for the next round.
      this.metrics.retryScheduled("pending");
      this.logger.warn("Pending reference retry failed, will retry", context);
      return false;
    }

    try {
      const failed = await this.markFailed(item);
      if (!failed) return false;
      this.metrics.transactionRecorded(failed.status, failed.kind);
      this.logger.error("Pending reference retry failed permanently, transaction is FAILED", {
        ...context,
        providerId: failed.providerId,
        correlationId: failed.idempotencyKey,
        failureCode: failed.failureCode,
      });
      return true;
    } catch (markError) {
      // Nothing was lost: the row stays due, so the next round tries it again.
      this.logger.error("Could not mark transaction as FAILED", { ...context, markError: describeError(markError) });
      return false;
    }
  }

  private markFailed({ id, walletId }: DuePendingReference): Promise<WagerTransaction | undefined> {
    return this.unitOfWork.transaction(async (repositories) => {
      await repositories.wallets.findByIdForUpdate(walletId);
      const transaction = await repositories.transactions.lockIfDuePendingReference(id);
      if (!transaction) return undefined;

      transaction.fail(FailureCode.ProcessingFailed);
      await repositories.transactions.update(transaction);
      await repositories.transactions.wakeWaitingFor({
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
      });
      return transaction;
    });
  }
}

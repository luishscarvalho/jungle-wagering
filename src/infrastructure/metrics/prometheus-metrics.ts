import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type {
  DuplicateSource,
  LockConflictKind,
  Metrics,
  ProcessingEntry,
  RetrySource,
} from "../../application/ports";
import type { FailureCode } from "../../domain/shared/failure-code";
import type { WagerTransactionKind, WagerTransactionStatus } from "../../domain/transaction/wager-transaction";

/**
 * A registry per instance instead of prom-client's global one, because the tests run
 * several apps in one process. Counters are per process: sum them across instances.
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Transactions entering a status, by status and kind",
    labelNames: ["status", "kind"],
    registers: [this.registry],
  });
  private readonly refusals = new Counter({
    name: "wagering_refusals_total",
    help: "Requests refused with no transaction written, by failure code",
    labelNames: ["failure_code"],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wagering_duplicates_total",
    help: "Duplicates detected, by where: http_replay, sqs_replay (new message, known idempotency key) or inbox",
    labelNames: ["source"],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Work put back to run again, by source: sqs, outbox or pending",
    labelNames: ["source"],
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: "wagering_dlq_messages_total",
    help: "Messages this consumer sent to the DLQ, by reason. Excludes the broker's own redrive",
    labelNames: ["reason"],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Transactions lost to contention: lock_timeout, deadlock or unique_race",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished event. NaN when it could not be read",
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "Time to process one operation, lock wait included, by entry: http, sqs or pending",
    labelNames: ["entry"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Reconciliations that found the stored balance different from the ledger",
    registers: [this.registry],
  });

  transactionRecorded(status: WagerTransactionStatus, kind: WagerTransactionKind): void {
    this.transactions.inc({ status, kind });
  }

  refused(failureCode: FailureCode): void {
    this.refusals.inc({ failure_code: failureCode });
  }

  duplicateDetected(source: DuplicateSource): void {
    this.duplicates.inc({ source });
  }

  retryScheduled(source: RetrySource): void {
    this.retries.inc({ source });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockConflict(kind: LockConflictKind): void {
    this.lockConflicts.inc({ kind });
  }

  processingObserved(entry: ProcessingEntry, seconds: number): void {
    this.processing.observe({ entry }, seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }
}

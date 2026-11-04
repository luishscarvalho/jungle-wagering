import { InboxMessage, type ReceiveInboxProps } from "../../domain/messaging/inbox-message";
import type { MoneyProps } from "../../domain/money/money";
import type { BackoffPolicy } from "../../domain/shared/backoff";
import { DomainError } from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/shared/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/transaction/wager-transaction";
import {
  type Clock,
  DuplicateTransactionError,
  type IdGenerator,
  type Metrics,
  type Repositories,
  type UnitOfWork,
} from "../ports";
import { RefusedError } from "../refused-error";
import { parseMoney, parseObject, parseText, parseUuid } from "../validation";
import { WagerSettlement } from "./wager-settlement";

export interface ProcessWagerInput {
  idempotencyKey: unknown;
  /** Untrusted: HTTP and SQS hand over the body as received, and validation lives here. */
  payload: unknown;
  correlationId?: string;
  causationId?: string;
  /** Given by the SQS consumer. The row commits together with the outcome, including refusals. */
  inbox?: Omit<ReceiveInboxProps, "receivedAt">;
}

export interface WagerResultView {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export type ProcessWagerResult =
  | { type: "result"; view: WagerResultView; kind: WagerTransactionKind }
  /**
   * Refused before writing a transaction. An inbox row, if any, still commits, except
   * for INVALID_PAYLOAD: the consumer dead-letters those, and a row would make a
   * redelivery after a crash look processed, losing the message before it reached the DLQ.
   */
  | { type: "refused"; failureCode: FailureCode; message: string }
  /** The inbox already holds this message with the same hash, so nothing was done. */
  | { type: "duplicate-message" }
  /** The inbox holds this message id with another hash, so nothing was done. */
  | { type: "message-conflict" };

const KINDS: Readonly<Record<string, WagerTransactionKind>> = {
  BET: WagerTransactionKind.Bet,
  WIN: WagerTransactionKind.Win,
  LOSS: WagerTransactionKind.Loss,
  REFUND: WagerTransactionKind.Refund,
  ROLLBACK: WagerTransactionKind.Rollback,
  OPENING: WagerTransactionKind.Opening,
};

function refused(failureCode: FailureCode, message: string): ProcessWagerResult {
  return { type: "refused", failureCode, message };
}

function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): ProcessWagerResult {
  return {
    type: "result",
    kind: transaction.kind,
    view: {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter?.toJSON() ?? null,
      ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay,
    },
  };
}

function answerExisting(existing: WagerTransaction, payloadHash: string): ProcessWagerResult {
  return existing.matchesPayload(payloadHash)
    ? resultOf(existing, true)
    : refused(FailureCode.IdempotencyConflict, "Idempotency key was already used with a different payload");
}

/** The single path for a wager operation, shared by the HTTP and SQS entries. */
export class ProcessWagerTransaction {
  private readonly settlement: WagerSettlement;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    referenceBackoff?: BackoffPolicy,
  ) {
    this.settlement = new WagerSettlement(ids, clock, referenceBackoff);
  }

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const startedAt = performance.now();
    try {
      const result = await this.process(input);
      this.record(input, result);
      return result;
    } finally {
      this.metrics.processingObserved(input.inbox ? "sqs" : "http", (performance.now() - startedAt) / 1000);
    }
  }

  /** Runs once the outcome has committed. A message-conflict is counted by the consumer, which dead-letters it. */
  private record(input: ProcessWagerInput, result: ProcessWagerResult): void {
    if (result.type === "refused") {
      this.metrics.refused(result.failureCode);
    } else if (result.type === "duplicate-message") {
      this.metrics.duplicateDetected("inbox");
    } else if (result.type === "result") {
      if (result.view.idempotentReplay) this.metrics.duplicateDetected(input.inbox ? "sqs_replay" : "http_replay");
      else this.metrics.transactionRecorded(result.view.status, result.kind);
    }
  }

  private async process(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    let transaction: WagerTransaction;
    try {
      transaction = this.buildTransaction(input);
    } catch (error) {
      if (error instanceof DomainError && error.failureCode) {
        const refusal = refused(error.failureCode, error.message);
        return input.inbox && error.failureCode !== FailureCode.InvalidPayload
          ? this.recordRefusal(input, refusal)
          : refusal;
      }
      throw error;
    }

    try {
      return await this.unitOfWork.transaction((repositories) => this.apply(input, transaction, repositories));
    } catch (error) {
      if (error instanceof DuplicateTransactionError) return this.answerAfterLostRace(input, transaction);
      throw error;
    }
  }

  private buildTransaction(input: ProcessWagerInput): WagerTransaction {
    const payload = parseObject(input.payload, "Payload");
    // hasOwn: "constructor" and the like must not resolve through the prototype.
    const kind = Object.hasOwn(KINDS, String(payload.kind)) ? KINDS[String(payload.kind)] : undefined;
    if (!kind) throw new RefusedError(FailureCode.InvalidPayload, "kind is not a known operation");

    const reference = payload.referenceExternalTransactionId ?? undefined;
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: parseText(payload.providerId, "providerId"),
      externalTransactionId: parseText(payload.externalTransactionId, "externalTransactionId"),
      idempotencyKey: parseText(input.idempotencyKey, "Idempotency key"),
      walletId: parseUuid(payload.walletId, "walletId"),
      playerId: parseUuid(payload.playerId, "playerId"),
      roundId: parseText(payload.roundId, "roundId"),
      gameId: parseText(payload.gameId, "gameId"),
      kind,
      money: parseMoney(payload.money, "money"),
      referenceExternalTransactionId:
        reference === undefined ? undefined : parseText(reference, "referenceExternalTransactionId"),
      createdAt: this.clock.now(),
    });
  }

  private async apply(
    input: ProcessWagerInput,
    transaction: WagerTransaction,
    repositories: Repositories,
  ): Promise<ProcessWagerResult> {
    const inboxAnswer = await this.recordInbox(input, repositories);
    if (inboxAnswer) return inboxAnswer;

    // Before the lock, so a replay on a hot wallet does not queue, and reusing a key is
    // a conflict wherever the new payload points, even at a wallet that does not exist.
    const known = await repositories.transactions.findByIdempotencyKey(transaction.idempotencyKey);
    if (known) return answerExisting(known, transaction.payloadHash);

    const wallet = await repositories.wallets.findByIdForUpdate(transaction.walletId);
    if (!wallet) return refused(FailureCode.WalletNotFound, "Wallet does not exist");
    if (wallet.currency !== transaction.money.currency) {
      return refused(FailureCode.CurrencyMismatch, "Currency differs from the wallet's");
    }
    if (wallet.playerId !== transaction.playerId) {
      return refused(FailureCode.PlayerMismatch, "Player differs from the wallet's");
    }

    // The source of truth: a concurrent duplicate on this wallet has committed by now, so it is visible.
    const existing = await repositories.transactions.findByIdempotencyKey(transaction.idempotencyKey);
    if (existing) return answerExisting(existing, transaction.payloadHash);

    const settled = await this.settlement.settle({
      transaction,
      wallet,
      repositories,
      correlationId: input.correlationId,
      causationId: input.causationId,
      save: () => repositories.transactions.insert(transaction),
    });
    if (settled.type === "refused") return refused(settled.failureCode, "Operation refused");

    return resultOf(transaction, false);
  }

  /**
   * The safety net behind the lookup under lock. A duplicate on another wallet does
   * not share the lock, so it can only be caught by the unique constraints. The failed
   * transaction rolled back, so this one starts over, inbox row included.
   */
  private answerAfterLostRace(input: ProcessWagerInput, transaction: WagerTransaction): Promise<ProcessWagerResult> {
    return this.unitOfWork.transaction(async (repositories) => {
      const inboxAnswer = await this.recordInbox(input, repositories);
      if (inboxAnswer) return inboxAnswer;

      const existing = await repositories.transactions.findByIdempotencyKey(transaction.idempotencyKey);
      if (existing) return answerExisting(existing, transaction.payloadHash);
      return refused(
        FailureCode.IdempotencyConflict,
        "This provider and external id were already used with a different idempotency key",
      );
    });
  }

  private recordRefusal(input: ProcessWagerInput, refusal: ProcessWagerResult): Promise<ProcessWagerResult> {
    return this.unitOfWork.transaction(async (repositories) => (await this.recordInbox(input, repositories)) ?? refusal);
  }

  /**
   * The message is recorded as processed right away, since it commits together with the
   * outcome. Returns the answer when the inbox already holds it, and undefined to go on.
   */
  private async recordInbox(input: ProcessWagerInput, repositories: Repositories): Promise<ProcessWagerResult | undefined> {
    if (!input.inbox) return undefined;
    const now = this.clock.now();
    const message = InboxMessage.receive({ ...input.inbox, receivedAt: now });
    message.markProcessed(now);
    if (await repositories.inbox.insertIfAbsent(message)) return undefined;

    const recorded = await repositories.inbox.find(message.consumerName, message.messageId);
    if (!recorded) throw new Error("Inbox row vanished after a conflicting insert");
    return recorded.matchesPayload(message.payloadHash) ? { type: "duplicate-message" } : { type: "message-conflict" };
  }
}

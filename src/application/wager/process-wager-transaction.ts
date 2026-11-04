import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from "../../domain/events/events";
import type { EventContext, IntegrationEvent } from "../../domain/events/integration-event";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { InboxMessage, type ReceiveInboxProps } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { MoneyProps } from "../../domain/money/money";
import { evaluateWagerPolicy } from "../../domain/policy/wager-policy";
import { DomainError } from "../../domain/shared/domain-error";
import { FailureCategory, FailureCode, failureCategoryOf } from "../../domain/shared/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import { type Clock, DuplicateTransactionError, type IdGenerator, type Repositories, type UnitOfWork } from "../ports";
import { RefusedError } from "../refused-error";
import { parseMoney, parseObject, parseText, parseUuid } from "../validation";

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
  | { type: "result"; view: WagerResultView }
  /** Refused before writing a transaction. An inbox row, if any, still commits. */
  | { type: "refused"; failureCode: FailureCode; message: string }
  /** The inbox already holds this message, so nothing was done. */
  | { type: "duplicate-message" };

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
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    let transaction: WagerTransaction;
    try {
      transaction = this.buildTransaction(input);
    } catch (error) {
      if (error instanceof DomainError && error.failureCode) {
        const refusal = refused(error.failureCode, error.message);
        return input.inbox ? this.recordRefusal(input, refusal) : refusal;
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
    const kind = KINDS[payload.kind as string];
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
    if (!(await this.recordInbox(input, repositories))) return { type: "duplicate-message" };

    const wallet = await repositories.wallets.findByIdForUpdate(transaction.walletId);
    if (!wallet) return refused(FailureCode.WalletNotFound, "Wallet does not exist");
    if (wallet.currency !== transaction.money.currency) {
      return refused(FailureCode.CurrencyMismatch, "Currency differs from the wallet's");
    }
    if (wallet.playerId !== transaction.playerId) {
      return refused(FailureCode.PlayerMismatch, "Player differs from the wallet's");
    }

    // Only after the lock: a concurrent duplicate on this wallet has committed by now, so it is visible.
    const existing = await repositories.transactions.findByIdempotencyKey(transaction.idempotencyKey);
    if (existing) return answerExisting(existing, transaction.payloadHash);

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
      events.push(WagerTransactionProcessed.from(transaction, this.eventContext(input, transaction, now)));
      if (entry) events.push(WalletBalanceChanged.from(wallet, entry, this.eventContext(input, transaction, now)));
    } else if (outcome.type === "await-reference") {
      transaction.markPendingReference(now);
      events.push(WagerTransactionPendingReference.from(transaction, this.eventContext(input, transaction, now)));
    } else {
      if (failureCategoryOf(outcome.failureCode) !== FailureCategory.Business) {
        return refused(outcome.failureCode, "Operation refused");
      }
      transaction.reject(outcome.failureCode, wallet.balance);
      events.push(WagerTransactionRejected.from(transaction, this.eventContext(input, transaction, now)));
    }

    // In this order for the foreign keys: the ledger points at the transaction.
    await repositories.transactions.insert(transaction);
    if (entry) {
      await repositories.ledger.insert(entry);
      await repositories.wallets.update(wallet);
    }
    for (const event of events) await repositories.outbox.insert(OutboxMessage.enqueue(event));

    return resultOf(transaction, false);
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

  private eventContext(input: ProcessWagerInput, transaction: WagerTransaction, occurredAt: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: input.correlationId ?? transaction.idempotencyKey,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      occurredAt,
    };
  }

  /**
   * The safety net behind the lookup under lock. A duplicate on another wallet does
   * not share the lock, so it can only be caught by the unique constraints. The failed
   * transaction rolled back, so this one starts over, inbox row included.
   */
  private answerAfterLostRace(input: ProcessWagerInput, transaction: WagerTransaction): Promise<ProcessWagerResult> {
    return this.unitOfWork.transaction(async (repositories) => {
      if (!(await this.recordInbox(input, repositories))) return { type: "duplicate-message" };

      const existing = await repositories.transactions.findByIdempotencyKey(transaction.idempotencyKey);
      if (existing) return answerExisting(existing, transaction.payloadHash);
      return refused(
        FailureCode.IdempotencyConflict,
        "This provider and external id were already used with a different idempotency key",
      );
    });
  }

  private recordRefusal(input: ProcessWagerInput, refusal: ProcessWagerResult): Promise<ProcessWagerResult> {
    return this.unitOfWork.transaction(async (repositories) =>
      (await this.recordInbox(input, repositories)) ? refusal : { type: "duplicate-message" },
    );
  }

  /** The message is recorded as processed right away, since it commits together with the outcome. */
  private async recordInbox(input: ProcessWagerInput, repositories: Repositories): Promise<boolean> {
    if (!input.inbox) return true;
    const now = this.clock.now();
    const message = InboxMessage.receive({ ...input.inbox, receivedAt: now });
    message.markProcessed(now);
    return repositories.inbox.insertIfAbsent(message);
  }
}

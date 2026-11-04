import { LedgerDirection } from "../ledger/wallet-ledger-entry";
import type { Money } from "../money/money";
import { CurrencyMismatchError } from "../money/money.errors";
import { type BackoffPolicy, nextAttemptAfter } from "../shared/backoff";
import { FailureCategory, type FailureCode, failureCategoryOf } from "../shared/failure-code";
import type { Wallet } from "../wallet/wallet";
import { computePayloadHash } from "./payload-hash";
import {
  InvalidFailureCodeError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  KindNotAllowedError,
} from "./wager-transaction.errors";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export const INTERNAL_PROVIDER_ID = "internal";
export const MAX_REFERENCE_ATTEMPTS = 10;

const OPENING_ROUND_AND_GAME = "opening";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  payloadHash: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** The id at the provider, not the internal id. */
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _balanceAfter: Money | undefined;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._balanceAfter = state.balanceAfter;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._processedAt = state.processedAt;
  }

  /** Entry point for provider operations. Starts as PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new KindNotAllowedError(props.kind);
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`Provider id "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    const required = [
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];
    if (required.some((value) => !value)) {
      throw new InvalidWagerTransactionError("Transaction identifiers cannot be empty");
    }

    const isLoss = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (props.money.isZero() && !isLoss)) {
      throw new InvalidWagerTransactionError("Amount must be positive, or zero for LOSS");
    }

    const isReversal = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (isReversal && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError("BET cannot have a reference");
    }

    return new WagerTransaction({
      ...props,
      payloadHash: computePayloadHash({ ...props, money: props.money.toJSON() }),
      status: WagerTransactionStatus.Pending,
      attempts: 0,
    });
  }

  /**
   * The internal credit behind a wallet's initial balance. It is applied together
   * with the wallet, so it starts as PROCESSED.
   */
  static createOpening(props: { id: string; wallet: Wallet; at: Date }): WagerTransaction {
    const { id, wallet, at } = props;
    if (wallet.version !== 1 || !wallet.balance.isPositive()) {
      throw new InvalidWagerTransactionError("OPENING requires a newly opened wallet with a positive balance");
    }
    const fields = {
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${wallet.id}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: OPENING_ROUND_AND_GAME,
      gameId: OPENING_ROUND_AND_GAME,
      kind: WagerTransactionKind.Opening,
    };
    return new WagerTransaction({
      ...fields,
      id,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${wallet.id}`,
      payloadHash: computePayloadHash({ ...fields, money: wallet.balance.toJSON() }),
      money: wallet.balance,
      createdAt: at,
      status: WagerTransactionStatus.Processed,
      balanceAfter: wallet.balance,
      attempts: 0,
      processedAt: at,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal();
    this.assertValidBalance(balanceAfter);
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  /**
   * First call schedules the first retry. Each later call is a reschedule and
   * increments attempts. The last retry rejects instead (see isLastReferenceAttempt).
   */
  markPendingReference(now: Date, backoff?: BackoffPolicy): void {
    this.assertNotTerminal();
    if (!this.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError("Transaction has no reference to wait for");
    }
    if (this._status === WagerTransactionStatus.PendingReference) {
      if (this.isLastReferenceAttempt()) {
        throw new InvalidTransactionStateError("Reference attempts are exhausted");
      }
      this._attempts += 1;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAfter(now, this._attempts + 1, backoff);
  }

  /** Stores balanceAfter because REJECTED has no ledger entry and replays must return it. */
  reject(code: FailureCode, balanceAfter: Money): void {
    this.assertNotTerminal();
    if (failureCategoryOf(code) !== FailureCategory.Business) {
      throw new InvalidFailureCodeError(`${code} is refused before persisting, not REJECTED`);
    }
    this.assertValidBalance(balanceAfter);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    if (failureCategoryOf(code) !== FailureCategory.Infrastructure) {
      throw new InvalidFailureCodeError(`${code} is not an infrastructure failure`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /**
   * True on the retry that uses up MAX_REFERENCE_ATTEMPTS. attempts counts past
   * reschedules, so with a limit of 10 the retries run at attempts 0 through 9.
   */
  isLastReferenceAttempt(): boolean {
    return this._status === WagerTransactionStatus.PendingReference && this._attempts + 1 >= MAX_REFERENCE_ATTEMPTS;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Undefined for LOSS, which moves no balance. ROLLBACK inverts its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        const reversed = reference?.kind === WagerTransactionKind.Rollback ? undefined : reference?.ledgerDirectionFor();
        if (!reversed) {
          throw new InvalidTransactionStateError("ROLLBACK needs a reference that moved the balance");
        }
        return reversed === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Transaction ${this.id} is already ${this._status}`);
    }
  }

  private assertValidBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new CurrencyMismatchError(this.money.currency, balance.currency);
    }
    if (balance.isNegative()) {
      throw new InvalidTransactionStateError("balanceAfter cannot be negative");
    }
  }
}

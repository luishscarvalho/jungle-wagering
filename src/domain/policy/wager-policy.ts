import { LedgerDirection } from "../ledger/wallet-ledger-entry";
import { FailureCode } from "../shared/failure-code";
import { InvalidTransactionStateError } from "../transaction/wager-transaction.errors";
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../transaction/wager-transaction";
import type { Wallet } from "../wallet/wallet";

export interface WagerPolicyInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** The transaction found for referenceExternalTransactionId, if any. */
  reference: WagerTransaction | undefined;
  /** Whether a processed REFUND or ROLLBACK already points at the reference. */
  referenceAlreadyReversed: boolean;
}

export type WagerOutcome =
  | {
      type: "process";
      /** Undefined when the balance does not move (LOSS). */
      direction: LedgerDirection | undefined;
      referenceTransactionId: string | undefined;
    }
  | { type: "reject"; failureCode: FailureCode }
  | { type: "await-reference" };

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

function reject(failureCode: FailureCode): WagerOutcome {
  return { type: "reject", failureCode };
}

/**
 * Decides what happens to a transaction, without changing anything. A reject
 * carries a code whose category tells the caller what to do: business codes are
 * persisted as REJECTED, contract codes are refused with no row written.
 */
export function evaluateWagerPolicy(input: WagerPolicyInput): WagerOutcome {
  const { transaction, wallet, reference, referenceAlreadyReversed } = input;

  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(`Transaction ${transaction.id} is already ${transaction.status}`);
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidTransactionStateError("Policy received a wallet other than the transaction's");
  }

  // OPENING is created already applied and never goes through the policy.
  if (transaction.kind === WagerTransactionKind.Opening) return reject(FailureCode.KindNotAllowed);
  if (transaction.playerId !== wallet.playerId) return reject(FailureCode.PlayerMismatch);
  if (transaction.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

  if (transaction.referenceExternalTransactionId) {
    if (!reference) return awaitOrGiveUp(transaction, FailureCode.ReferenceNotFound);

    const refusal = checkReference(transaction, reference, referenceAlreadyReversed);
    if (refusal) return refusal;
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
    return reject(
      transaction.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalInsufficientFunds,
    );
  }

  return {
    type: "process",
    direction,
    referenceTransactionId: transaction.referenceExternalTransactionId ? reference?.id : undefined,
  };
}

function checkReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): WagerOutcome | undefined {
  const sameScope =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameScope) return reject(FailureCode.ReferenceMismatch);

  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) {
    return reject(FailureCode.ReferenceInvalidKind);
  }

  // A reference still in flight can still become PROCESSED, so it is worth waiting.
  if (!reference.isTerminal()) return awaitOrGiveUp(transaction, FailureCode.ReferenceNotProcessed);
  if (reference.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);

  if (transaction.requiresReference()) {
    if (alreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
    if (!transaction.money.equals(reference.money)) return reject(FailureCode.AmountMismatch);
  }
  return undefined;
}

function awaitOrGiveUp(transaction: WagerTransaction, codeWhenExhausted: FailureCode): WagerOutcome {
  return transaction.isLastReferenceAttempt() ? reject(codeWhenExhausted) : { type: "await-reference" };
}

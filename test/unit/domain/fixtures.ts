import { Money } from "../../../src/domain/money/money";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../../src/domain/transaction/wager-transaction";
import { Wallet, type WalletState } from "../../../src/domain/wallet/wallet";

export const AT = new Date("2026-01-01T00:00:00.000Z");
export const LATER = new Date("2026-01-01T00:01:00.000Z");
export const WALLET_ID = "wallet-1";
export const PLAYER_ID = "player-1";

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

export function aWallet(balance = "100.00", overrides: Partial<WalletState> = {}): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    balance: brl(balance),
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function createProps(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const needsReference = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: brl("25.00"),
    createdAt: AT,
    ...(needsReference ? { referenceExternalTransactionId: "ext-ref" } : {}),
    ...overrides,
  };
}

export function aTransaction(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(createProps(kind, overrides));
}

/** A persisted transaction, by default PROCESSED, to act as a resolved reference. */
export function aReference(
  kind: WagerTransactionKind = WagerTransactionKind.Bet,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...createProps(kind, { id: "tx-ref", externalTransactionId: "ext-ref", idempotencyKey: "provider-a:ext-ref" }),
    payloadHash: "hash",
    status: WagerTransactionStatus.Processed,
    attempts: 0,
    balanceAfter: brl("75.00"),
    processedAt: AT,
    ...overrides,
  });
}

/** A transaction waiting for its reference, with a given number of past reschedules. */
export function aPendingReference(kind: WagerTransactionKind, attempts: number): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...createProps(kind, { referenceExternalTransactionId: "ext-ref" }),
    payloadHash: "hash",
    status: WagerTransactionStatus.PendingReference,
    attempts,
    nextAttemptAt: AT,
  });
}

export function aFinished(status: WagerTransactionStatus): WagerTransaction {
  const transaction = aTransaction(WagerTransactionKind.Bet);
  return WagerTransaction.rehydrate({
    ...createProps(WagerTransactionKind.Bet),
    payloadHash: transaction.payloadHash,
    status,
    attempts: 0,
  });
}

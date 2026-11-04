import { FailureCode } from "../domain/shared/failure-code";
import type { UnitOfWork } from "./ports";
import { RefusedError } from "./refused-error";
import { parseText, parseUuid } from "./validation";
import { ledgerEntryView, transactionView, walletView } from "./views";

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

function invalid(message: string): RefusedError {
  return new RefusedError(FailureCode.InvalidPayload, message);
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LEDGER_LIMIT;
  const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
    throw invalid(`limit must be an integer from 1 to ${MAX_LEDGER_LIMIT}`);
  }
  return limit;
}

function encodeCursor(entryId: string): string {
  return Buffer.from(entryId, "utf8").toString("base64url");
}

function decodeCursor(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw invalid("cursor is invalid");
  try {
    return parseUuid(Buffer.from(raw, "base64url").toString("utf8"), "cursor");
  } catch {
    throw invalid("cursor is invalid");
  }
}

export class WalletQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async getWallet(rawWalletId: unknown) {
    const wallet = await this.unitOfWork.reader().wallets.findById(parseUuid(rawWalletId, "walletId"));
    if (!wallet) throw new RefusedError(FailureCode.WalletNotFound, "Wallet does not exist");
    return walletView(wallet);
  }

  async listLedger(rawWalletId: unknown, query: { cursor?: unknown; limit?: unknown }) {
    const walletId = parseUuid(rawWalletId, "walletId");
    const limit = parseLimit(query.limit);
    const afterId = decodeCursor(query.cursor);

    const reader = this.unitOfWork.reader();
    const wallet = await reader.wallets.findById(walletId);
    if (!wallet) throw new RefusedError(FailureCode.WalletNotFound, "Wallet does not exist");

    // One extra row tells whether another page exists, without a separate count.
    const entries = await reader.ledger.listPage(walletId, wallet.currency, afterId, limit + 1);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(ledgerEntryView),
      nextCursor: entries.length > limit && last ? encodeCursor(last.id) : null,
    };
  }
}

export class TransactionQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async getById(rawTransactionId: unknown) {
    const id = parseUuid(rawTransactionId, "transactionId");
    const transaction = await this.unitOfWork.reader().transactions.findById(id);
    if (!transaction) throw new RefusedError(FailureCode.ResourceNotFound, "Transaction does not exist");
    return transactionView(transaction);
  }

  async getByExternalId(rawProviderId: unknown, rawExternalId: unknown) {
    const transaction = await this.unitOfWork
      .reader()
      .transactions.findByProviderAndExternalId(
        parseText(rawProviderId, "providerId"),
        parseText(rawExternalId, "externalTransactionId"),
      );
    if (!transaction) throw new RefusedError(FailureCode.ResourceNotFound, "Transaction does not exist");
    return transactionView(transaction);
  }
}

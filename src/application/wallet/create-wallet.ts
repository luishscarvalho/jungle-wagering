import { WagerTransactionProcessed, WalletBalanceChanged } from "../../domain/events/events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { FailureCode } from "../../domain/shared/failure-code";
import { WagerTransaction } from "../../domain/transaction/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { type Clock, DuplicateWalletError, type IdGenerator, type UnitOfWork } from "../ports";
import { RefusedError } from "../refused-error";
import { parseMoney, parseObject, parseUuid } from "../validation";
import { walletView } from "../views";

export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** @throws RefusedError */
  async execute(input: unknown) {
    const payload = parseObject(input, "Payload");
    const playerId = parseUuid(payload.playerId, "playerId");
    const initialBalance = parseMoney(payload.initialBalance, "initialBalance");
    const at = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId, initialBalance, at });

    try {
      await this.unitOfWork.transaction(async (repositories) => {
        await repositories.wallets.insert(wallet);
        if (!initialBalance.isPositive()) return;

        const opening = WagerTransaction.createOpening({ id: this.ids.next(), wallet, at });
        const entry = wallet.openingLedgerEntry({ entryId: this.ids.next(), transactionId: opening.id, at });
        await repositories.transactions.insert(opening);
        await repositories.ledger.insert(entry);

        const context = () => ({ eventId: this.ids.next(), correlationId: wallet.id, occurredAt: at });
        await repositories.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())));
        await repositories.outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context())));
      });
    } catch (error) {
      if (error instanceof DuplicateWalletError) {
        throw new RefusedError(FailureCode.WalletAlreadyExists, "Player already has a wallet in this currency");
      }
      throw error;
    }
    return walletView(wallet);
  }
}

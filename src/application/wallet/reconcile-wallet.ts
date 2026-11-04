import { FailureCode } from "../../domain/shared/failure-code";
import type { AppLogger, Metrics, UnitOfWork } from "../ports";
import { RefusedError } from "../refused-error";
import { parseUuid } from "../validation";

export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly logger: Pick<AppLogger, "warn">,
    private readonly metrics: Pick<Metrics, "reconciliationDivergence">,
  ) {}

  /** Only reports: a divergence is logged and flagged, never corrected. */
  async execute(rawWalletId: unknown) {
    const walletId = parseUuid(rawWalletId, "walletId");
    const snapshot = await this.unitOfWork.reader().ledger.reconciliationSnapshot(walletId);
    if (!snapshot) throw new RefusedError(FailureCode.WalletNotFound, "Wallet does not exist");

    const difference = snapshot.stored.subtract(snapshot.calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.warn("Wallet balance diverges from its ledger", {
        walletId,
        difference: difference.toJSON(),
        checkedEntries: snapshot.checkedEntries,
      });
    }

    return {
      walletId,
      storedBalance: snapshot.stored.toJSON(),
      calculatedBalance: snapshot.calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}

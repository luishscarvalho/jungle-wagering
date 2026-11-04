import { DomainError } from "../shared/domain-error";

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  constructor() {
    super("Ledger entry is unbalanced: balanceBefore +/- money must equal balanceAfter");
  }
}

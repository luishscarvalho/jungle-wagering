import { DomainError } from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";

export class InsufficientFundsError extends DomainError {
  constructor(readonly walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`, FailureCode.InsufficientFunds);
  }
}

export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

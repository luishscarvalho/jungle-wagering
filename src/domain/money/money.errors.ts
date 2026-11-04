import { DomainError } from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`, FailureCode.CurrencyMismatch);
  }
}

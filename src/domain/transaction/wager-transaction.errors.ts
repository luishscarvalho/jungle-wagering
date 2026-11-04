import { DomainError } from "../shared/domain-error";
import { FailureCode } from "../shared/failure-code";

/** A transition that the state machine forbids. Always a programming error. */
export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super(message, FailureCode.InvalidPayload);
  }
}

export class KindNotAllowedError extends DomainError {
  constructor(kind: string) {
    super(`Transaction kind ${kind} cannot be submitted`, FailureCode.KindNotAllowed);
  }
}

/** A failure code from the wrong category for the transition, such as REJECTED with a contract code. */
export class InvalidFailureCodeError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

import { DomainError } from "../domain/shared/domain-error";
import type { FailureCode } from "../domain/shared/failure-code";

/** A request the application refuses with a code the caller can act on. */
export class RefusedError extends DomainError {
  constructor(failureCode: FailureCode, message: string) {
    super(message, failureCode);
  }
}

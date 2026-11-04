import type { FailureCode } from "./failure-code";

/**
 * Base of every domain error. failureCode is set when the error maps to a code a
 * caller can act on. Errors without one signal a programming mistake.
 */
export abstract class DomainError extends Error {
  protected constructor(
    message: string,
    readonly failureCode?: FailureCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

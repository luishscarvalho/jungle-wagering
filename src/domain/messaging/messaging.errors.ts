import { DomainError } from "../shared/domain-error";

export class InvalidMessageStateError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

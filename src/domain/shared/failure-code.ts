export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",

  InvalidPayload = "INVALID_PAYLOAD",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerMismatch = "PLAYER_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  KindNotAllowed = "KIND_NOT_ALLOWED",
  ResourceNotFound = "RESOURCE_NOT_FOUND",

  IdempotencyConflict = "IDEMPOTENCY_CONFLICT",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",

  InfrastructureUnavailable = "INFRASTRUCTURE_UNAVAILABLE",
  ProcessingFailed = "PROCESSING_FAILED",
}

/**
 * business: persisted as REJECTED.
 * contract: refused before persisting, no row is written.
 * conflict: refused, the original row stays as it was.
 * infrastructure: transient (retry) or permanent (FAILED).
 */
export enum FailureCategory {
  Business = "business",
  Contract = "contract",
  Conflict = "conflict",
  Infrastructure = "infrastructure",
}

const CATEGORIES: Readonly<Record<FailureCode, FailureCategory>> = {
  [FailureCode.InsufficientFunds]: FailureCategory.Business,
  [FailureCode.ReversalInsufficientFunds]: FailureCategory.Business,
  [FailureCode.ReferenceNotFound]: FailureCategory.Business,
  [FailureCode.ReferenceInvalidKind]: FailureCategory.Business,
  [FailureCode.ReferenceMismatch]: FailureCategory.Business,
  [FailureCode.ReferenceNotProcessed]: FailureCategory.Business,
  [FailureCode.ReferenceAlreadyReversed]: FailureCategory.Business,
  [FailureCode.AmountMismatch]: FailureCategory.Business,

  [FailureCode.InvalidPayload]: FailureCategory.Contract,
  [FailureCode.CurrencyMismatch]: FailureCategory.Contract,
  [FailureCode.PlayerMismatch]: FailureCategory.Contract,
  [FailureCode.WalletNotFound]: FailureCategory.Contract,
  [FailureCode.KindNotAllowed]: FailureCategory.Contract,
  [FailureCode.ResourceNotFound]: FailureCategory.Contract,

  [FailureCode.IdempotencyConflict]: FailureCategory.Conflict,
  [FailureCode.WalletAlreadyExists]: FailureCategory.Conflict,

  [FailureCode.InfrastructureUnavailable]: FailureCategory.Infrastructure,
  [FailureCode.ProcessingFailed]: FailureCategory.Infrastructure,
};

export function failureCategoryOf(code: FailureCode): FailureCategory {
  return CATEGORIES[code];
}

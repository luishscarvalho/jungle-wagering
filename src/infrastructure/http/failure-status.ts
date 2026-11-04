import { HttpStatus } from "@nestjs/common";
import { FailureCategory, FailureCode, failureCategoryOf } from "../../domain/shared/failure-code";

const NON_BUSINESS_STATUS: Partial<Record<FailureCode, HttpStatus>> = {
  [FailureCode.InvalidPayload]: HttpStatus.BAD_REQUEST,
  [FailureCode.CurrencyMismatch]: HttpStatus.BAD_REQUEST,
  [FailureCode.PlayerMismatch]: HttpStatus.BAD_REQUEST,
  [FailureCode.KindNotAllowed]: HttpStatus.BAD_REQUEST,
  [FailureCode.WalletNotFound]: HttpStatus.NOT_FOUND,
  [FailureCode.ResourceNotFound]: HttpStatus.NOT_FOUND,
  [FailureCode.IdempotencyConflict]: HttpStatus.CONFLICT,
  [FailureCode.WalletAlreadyExists]: HttpStatus.CONFLICT,
  [FailureCode.InfrastructureUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [FailureCode.ProcessingFailed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export function httpStatusOf(code: FailureCode): HttpStatus {
  if (failureCategoryOf(code) === FailureCategory.Business) return HttpStatus.UNPROCESSABLE_ENTITY;
  return NON_BUSINESS_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { DomainError } from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/shared/failure-code";
import { httpStatusOf } from "./failure-status";
import { describeError, isTransientInfrastructureError } from "../transient-errors";

function codeForHttpStatus(status: number): FailureCode {
  if (status === HttpStatus.NOT_FOUND) return FailureCode.ResourceNotFound;
  if (status === HttpStatus.SERVICE_UNAVAILABLE) return FailureCode.InfrastructureUnavailable;
  return status < 500 ? FailureCode.InvalidPayload : FailureCode.ProcessingFailed;
}

/** Makes every error body carry a failureCode, including the ones Nest and Express raise. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.describe(exception);
    response.status(status).json(body);
  }

  private describe(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof DomainError && exception.failureCode) {
      const failureCode = exception.failureCode;
      return { status: httpStatusOf(failureCode), body: { failureCode, message: exception.message } };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const failureCode = codeForHttpStatus(status);
      return typeof response === "object"
        ? { status, body: { failureCode, ...response } }
        : { status, body: { failureCode, message: response } };
    }

    if (isTransientInfrastructureError(exception)) {
      this.logger.warn({ message: "Transient infrastructure failure", ...describeError(exception) });
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { failureCode: FailureCode.InfrastructureUnavailable, message: "Temporarily unavailable, retry later" },
      };
    }

    this.logger.error({ message: "Unexpected error", ...describeError(exception) });
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { failureCode: FailureCode.ProcessingFailed, message: "Internal error" },
    };
  }
}

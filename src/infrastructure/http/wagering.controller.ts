import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { APP_LOGGER, type AppLogger } from "../../application/ports";
import { TransactionQueries } from "../../application/queries";
import { RefusedError } from "../../application/refused-error";
import { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction";
import { FailureCode } from "../../domain/shared/failure-code";
import { WagerTransactionStatus } from "../../domain/transaction/wager-transaction";
import { httpStatusOf } from "./failure-status";

function httpStatusOfResult(status: WagerTransactionStatus, failureCode: FailureCode | undefined): HttpStatus {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return httpStatusOf(failureCode ?? FailureCode.ProcessingFailed);
  }
}

/** Identifiers only: the amounts of a request stay out of the logs. */
function logContext(idempotencyKey: string | undefined, body: unknown): Record<string, unknown> {
  const { providerId, walletId } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return {
    correlationId: idempotencyKey,
    providerId: typeof providerId === "string" ? providerId : undefined,
    walletId: typeof walletId === "string" ? walletId : undefined,
  };
}

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: TransactionQueries,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.processWager.execute({ idempotencyKey, payload: body });
    const context = logContext(idempotencyKey, body);
    if (result.type === "refused") {
      this.logger.info("Transaction refused", { ...context, failureCode: result.failureCode });
      throw new RefusedError(result.failureCode, result.message);
    }
    if (result.type !== "result") throw new Error("HTTP requests do not use the inbox");

    this.logger.info("Transaction submitted", {
      ...context,
      transactionId: result.view.transactionId,
      status: result.view.status,
      failureCode: result.view.failureCode,
      idempotentReplay: result.view.idempotentReplay,
    });
    response.status(httpStatusOfResult(result.view.status, result.view.failureCode));
    return result.view;
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string) {
    return this.queries.getById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(@Param("providerId") providerId: string, @Param("externalTransactionId") externalId: string) {
    return this.queries.getByExternalId(providerId, externalId);
  }
}

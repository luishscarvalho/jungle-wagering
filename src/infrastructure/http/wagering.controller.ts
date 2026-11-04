import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
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

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: TransactionQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.processWager.execute({ idempotencyKey, payload: body });
    if (result.type === "refused") throw new RefusedError(result.failureCode, result.message);
    if (result.type === "duplicate-message") throw new Error("HTTP requests do not use the inbox");

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

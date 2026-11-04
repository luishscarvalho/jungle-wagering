import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { WalletQueries } from "../../application/queries";
import { CreateWallet } from "../../application/wallet/create-wallet";
import { ReconcileWallet } from "../../application/wallet/reconcile-wallet";

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly queries: WalletQueries,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    return this.createWallet.execute(body);
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(@Param("walletId") walletId: string, @Query("cursor") cursor: unknown, @Query("limit") limit: unknown) {
    return this.queries.listLedger(walletId, { cursor, limit });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  reconcile(@Param("walletId") walletId: string) {
    return this.reconcileWallet.execute(walletId);
  }
}

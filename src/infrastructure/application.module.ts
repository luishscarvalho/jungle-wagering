import { Global, Module } from "@nestjs/common";
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../application/ports";
import { TransactionQueries, WalletQueries } from "../application/queries";
import { ProcessWagerTransaction } from "../application/wager/process-wager-transaction";
import { CreateWallet } from "../application/wallet/create-wallet";
import { ReconcileWallet } from "../application/wallet/reconcile-wallet";
import { NestAppLogger, systemClock, uuidV7Generator } from "./system";

// Use cases are plain classes, so the application layer does not depend on Nest.
const USE_CASES = [ProcessWagerTransaction, CreateWallet, ReconcileWallet, WalletQueries, TransactionQueries];

@Global()
@Module({
  providers: [
    { provide: ID_GENERATOR, useValue: uuidV7Generator },
    { provide: CLOCK, useValue: systemClock },
    { provide: APP_LOGGER, useClass: NestAppLogger },
    {
      provide: ProcessWagerTransaction,
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new ProcessWagerTransaction(unitOfWork, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: CreateWallet,
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) => new CreateWallet(unitOfWork, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: ReconcileWallet,
      useFactory: (unitOfWork: UnitOfWork, logger: AppLogger) => new ReconcileWallet(unitOfWork, logger),
      inject: [UNIT_OF_WORK, APP_LOGGER],
    },
    {
      provide: WalletQueries,
      useFactory: (unitOfWork: UnitOfWork) => new WalletQueries(unitOfWork),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: TransactionQueries,
      useFactory: (unitOfWork: UnitOfWork) => new TransactionQueries(unitOfWork),
      inject: [UNIT_OF_WORK],
    },
  ],
  exports: [...USE_CASES, APP_LOGGER],
})
export class ApplicationModule {}

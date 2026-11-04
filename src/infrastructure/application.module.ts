import { Global, Module } from "@nestjs/common";
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  METRICS,
  type Metrics,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../application/ports";
import { TransactionQueries, WalletQueries } from "../application/queries";
import { ProcessWagerTransaction } from "../application/wager/process-wager-transaction";
import { CreateWallet } from "../application/wallet/create-wallet";
import { ReconcileWallet } from "../application/wallet/reconcile-wallet";
import { APP_CONFIG, type AppConfig } from "./config";
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
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock, metrics: Metrics, config: AppConfig) =>
        new ProcessWagerTransaction(unitOfWork, ids, clock, metrics, config.pending.backoff),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS, APP_CONFIG],
    },
    {
      provide: CreateWallet,
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock, metrics: Metrics) =>
        new CreateWallet(unitOfWork, ids, clock, metrics),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS],
    },
    {
      provide: ReconcileWallet,
      useFactory: (unitOfWork: UnitOfWork, logger: AppLogger, metrics: Metrics) =>
        new ReconcileWallet(unitOfWork, logger, metrics),
      inject: [UNIT_OF_WORK, APP_LOGGER, METRICS],
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
  exports: [...USE_CASES, APP_LOGGER, ID_GENERATOR, CLOCK],
})
export class ApplicationModule {}

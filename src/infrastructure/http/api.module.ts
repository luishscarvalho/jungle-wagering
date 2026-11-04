import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { AuthGuard } from "./auth.guard";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class ApiModule {}

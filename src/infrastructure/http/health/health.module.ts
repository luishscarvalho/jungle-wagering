import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PostgresHealthCheck, SqsHealthCheck } from "./health.checks";

@Module({
  controllers: [HealthController],
  providers: [PostgresHealthCheck, SqsHealthCheck],
})
export class HealthModule {}

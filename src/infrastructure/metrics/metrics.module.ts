import { Global, Module } from "@nestjs/common";
import { METRICS } from "../../application/ports";
import { MetricsController } from "./metrics.controller";
import { PrometheusMetrics } from "./prometheus-metrics";

@Global()
@Module({
  controllers: [MetricsController],
  providers: [{ provide: METRICS, useClass: PrometheusMetrics }],
  exports: [METRICS],
})
export class MetricsModule {}

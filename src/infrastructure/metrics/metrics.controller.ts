import { Controller, Get, Header, Inject } from "@nestjs/common";
import { contentType } from "prom-client";
import { APP_LOGGER, type AppLogger, METRICS, UNIT_OF_WORK, type UnitOfWork } from "../../application/ports";
import { Public } from "../http/auth.guard";
import { describeError } from "../transient-errors";
import type { PrometheusMetrics } from "./prometheus-metrics";

const LAG_READ_TIMEOUT_MS = 2000;

@Public()
@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: PrometheusMetrics,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  @Get()
  @Header("Content-Type", contentType)
  async scrape(): Promise<string> {
    this.metrics.setOutboxLag(await this.readOutboxLag());
    return this.metrics.registry.metrics();
  }

  /** Read at scrape time, so it is the same in every instance. With the database out, counters are still worth serving. */
  private async readOutboxLag(): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Outbox lag read timed out")), LAG_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.unitOfWork.reader().outbox.oldestPendingAgeSeconds(), timeout]);
    } catch (error) {
      this.logger.warn("Could not read the outbox lag", describeError(error));
      return Number.NaN;
    } finally {
      clearTimeout(timer);
    }
  }
}

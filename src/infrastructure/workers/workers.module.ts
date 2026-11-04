import { SQSClient } from "@aws-sdk/client-sqs";
import { type BeforeApplicationShutdown, Inject, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { PublishOutbox } from "../../application/outbox/publish-outbox";
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
} from "../../application/ports";
import { ProcessPendingReferences } from "../../application/wager/process-pending-references";
import { APP_CONFIG, type AppConfig } from "../config";
import { SqsEventPublisher } from "../sqs/sqs-event-publisher";
import { isTransientInfrastructureError } from "../transient-errors";
import { PollingWorker } from "./polling-worker";

// Each round holds row locks while it publishes, so a broker that hangs must fail fast.
const PUBLISH_REQUEST_TIMEOUT_MS = 5000;

const OUTBOX_WORKER = Symbol("OUTBOX_WORKER");
const PENDING_REFERENCE_WORKER = Symbol("PENDING_REFERENCE_WORKER");

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.sqs.region,
          endpoint: config.sqs.endpoint,
          maxAttempts: 1,
          requestHandler: { connectionTimeout: 2000, requestTimeout: PUBLISH_REQUEST_TIMEOUT_MS },
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: OUTBOX_WORKER,
      useFactory: (
        config: AppConfig,
        client: SQSClient,
        unitOfWork: UnitOfWork,
        clock: Clock,
        logger: AppLogger,
        metrics: Metrics,
      ) => {
        const publisher = new SqsEventPublisher(client, config.outbox.eventsQueueName);
        const useCase = new PublishOutbox(unitOfWork, publisher, clock, logger, metrics, config.outbox.backoff);
        return new PollingWorker(() => useCase.runRound(), logger, {
          name: "outbox",
          pollIntervalMs: config.outbox.pollIntervalMs,
          shutdownGraceMs: config.sqs.shutdownGraceMs,
        });
      },
      inject: [APP_CONFIG, SQSClient, UNIT_OF_WORK, CLOCK, APP_LOGGER, METRICS],
    },
  ],
})
export class OutboxWorkerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(OUTBOX_WORKER) private readonly worker: PollingWorker,
    @Inject(SQSClient) private readonly client: SQSClient,
  ) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }

  // Before DatabaseModule closes the pool, which happens in onApplicationShutdown.
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
    this.client.destroy();
  }
}

@Module({
  providers: [
    {
      provide: PENDING_REFERENCE_WORKER,
      useFactory: (
        config: AppConfig,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        logger: AppLogger,
        metrics: Metrics,
      ) => {
        const useCase = new ProcessPendingReferences(
          unitOfWork,
          ids,
          clock,
          logger,
          metrics,
          isTransientInfrastructureError,
          config.pending.backoff,
        );
        return new PollingWorker(() => useCase.runRound(), logger, {
          name: "pending",
          pollIntervalMs: config.pending.pollIntervalMs,
          shutdownGraceMs: config.sqs.shutdownGraceMs,
        });
      },
      inject: [APP_CONFIG, UNIT_OF_WORK, ID_GENERATOR, CLOCK, APP_LOGGER, METRICS],
    },
  ],
})
export class PendingReferenceWorkerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(PENDING_REFERENCE_WORKER) private readonly worker: PollingWorker) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.worker.stop();
  }
}

import { SQSClient } from "@aws-sdk/client-sqs";
import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { APP_LOGGER, type AppLogger, METRICS, type Metrics } from "../../application/ports";
import { ProcessWagerTransaction } from "../../application/wager/process-wager-transaction";
import { APP_CONFIG, type AppConfig } from "../config";
import { WagerConsumer } from "./wager-consumer";

@Module({
  providers: [
    {
      provide: WagerConsumer,
      useFactory: (config: AppConfig, processWager: ProcessWagerTransaction, logger: AppLogger, metrics: Metrics) =>
        new WagerConsumer(
          new SQSClient({ region: config.sqs.region, endpoint: config.sqs.endpoint }),
          processWager,
          logger,
          metrics,
          config.sqs,
        ),
      inject: [APP_CONFIG, ProcessWagerTransaction, APP_LOGGER, METRICS],
    },
  ],
  exports: [WagerConsumer],
})
export class SqsConsumerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(WagerConsumer) private readonly consumer: WagerConsumer) {}

  onApplicationBootstrap(): void {
    this.consumer.start();
  }

  // Before DatabaseModule closes the pool, which happens in onApplicationShutdown.
  beforeApplicationShutdown(): Promise<void> {
    return this.consumer.stop();
  }
}

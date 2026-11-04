import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { SQL } from "bun";
import { APP_CONFIG, type AppConfig } from "../../config";

@Injectable()
export class PostgresHealthCheck implements OnModuleDestroy {
  private readonly sql: SQL;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.sql = new SQL(config.databaseUrl, { max: 1, connectionTimeout: 2 });
  }

  async check(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.close();
  }
}

@Injectable()
export class SqsHealthCheck implements OnModuleDestroy {
  private readonly client: SQSClient;
  private readonly queueName: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.queueName = config.sqs.queueName;
    this.client = new SQSClient({
      region: config.sqs.region,
      endpoint: config.sqs.endpoint,
      // A probe must report the current state, so it does not retry.
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 2000 },
    });
  }

  // Looks up the queue instead of only pinging ministack: its state is in
  // memory, so a restarted ministack is reachable but has no queues.
  // The DLQ needs no check, since create-queues.sh creates it first and the
  // main queue's RedrivePolicy depends on it.
  async check(): Promise<void> {
    await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}

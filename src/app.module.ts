import { type DynamicModule, Module } from "@nestjs/common";
import { ApplicationModule } from "./infrastructure/application.module";
import { ConfigModule, type Role } from "./infrastructure/config";
import { DatabaseModule } from "./infrastructure/db/database.module";
import { ApiModule } from "./infrastructure/http/api.module";
import { HealthModule } from "./infrastructure/http/health/health.module";
import { MetricsModule } from "./infrastructure/metrics/metrics.module";
import { SqsConsumerModule } from "./infrastructure/sqs/sqs-consumer.module";
import { OutboxWorkerModule, PendingReferenceWorkerModule } from "./infrastructure/workers/workers.module";

@Module({})
export class AppModule {
  /** Health and metrics stay up in every role: every instance needs probes, and counters are per process. */
  static forRoles(roles: readonly Role[]): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule,
        MetricsModule,
        DatabaseModule,
        ApplicationModule,
        HealthModule,
        ...(roles.includes("api") ? [ApiModule] : []),
        ...(roles.includes("consumer") ? [SqsConsumerModule] : []),
        ...(roles.includes("outbox") ? [OutboxWorkerModule] : []),
        ...(roles.includes("pending") ? [PendingReferenceWorkerModule] : []),
      ],
    };
  }
}

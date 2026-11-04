import { type DynamicModule, Module } from "@nestjs/common";
import { ApplicationModule } from "./infrastructure/application.module";
import { ConfigModule, type Role } from "./infrastructure/config";
import { DatabaseModule } from "./infrastructure/db/database.module";
import { ApiModule } from "./infrastructure/http/api.module";
import { HealthModule } from "./infrastructure/http/health/health.module";
import { SqsConsumerModule } from "./infrastructure/sqs/sqs-consumer.module";

@Module({})
export class AppModule {
  /** Health endpoints stay up in every role, since every instance needs its probes. */
  static forRoles(roles: readonly Role[]): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule,
        DatabaseModule,
        ApplicationModule,
        HealthModule,
        ...(roles.includes("api") ? [ApiModule] : []),
        ...(roles.includes("consumer") ? [SqsConsumerModule] : []),
      ],
    };
  }
}

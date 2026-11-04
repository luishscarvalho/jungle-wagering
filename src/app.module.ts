import { Module } from "@nestjs/common";
import { ApplicationModule } from "./infrastructure/application.module";
import { ConfigModule } from "./infrastructure/config";
import { DatabaseModule } from "./infrastructure/db/database.module";
import { ApiModule } from "./infrastructure/http/api.module";
import { HealthModule } from "./infrastructure/http/health/health.module";

@Module({ imports: [ConfigModule, DatabaseModule, ApplicationModule, HealthModule, ApiModule] })
export class AppModule {}

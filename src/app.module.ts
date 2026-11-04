import { Module } from "@nestjs/common";
import { ConfigModule } from "./infrastructure/config";
import { HealthModule } from "./infrastructure/http/health/health.module";

@Module({ imports: [ConfigModule, HealthModule] })
export class AppModule {}

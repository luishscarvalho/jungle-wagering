import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { APP_CONFIG, type AppConfig } from "./infrastructure/config";

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(app.get<AppConfig>(APP_CONFIG).port);

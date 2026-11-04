import "reflect-metadata";
import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./infrastructure/config";

const config = loadConfig();
const app = await NestFactory.create(AppModule.forRoles(config.roles), { logger: new ConsoleLogger({ json: true }) });
app.enableShutdownHooks();
await app.listen(config.port);

import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { METRICS, type Metrics, UNIT_OF_WORK } from "../../application/ports";
import { APP_CONFIG, type AppConfig } from "../config";
import { createOrmConfig } from "./create-orm-config";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: (config: AppConfig) => MikroORM.init(createOrmConfig(config.databaseUrl, config.databasePoolMax)),
      inject: [APP_CONFIG],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM, metrics: Metrics) => new MikroOrmUnitOfWork(orm, metrics),
      inject: [MikroORM, METRICS],
    },
  ],
  exports: [MikroORM, UNIT_OF_WORK],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

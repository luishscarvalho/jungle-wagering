import type { MikroORM } from "@mikro-orm/postgresql";
import type { Repositories, UnitOfWork } from "../../application/ports";
import { createRepositories } from "./repositories";

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional((em) => work(createRepositories(em)));
  }

  reader(): Repositories {
    return createRepositories(this.orm.em.fork());
  }
}

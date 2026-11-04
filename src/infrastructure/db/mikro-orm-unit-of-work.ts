import type { MikroORM } from "@mikro-orm/postgresql";
import type { Repositories, UnitOfWork } from "../../application/ports";
import { createRepositories } from "./repositories";

/** Waiting longer on a hot wallet only holds a pooled connection: the caller gets a 503 or an SQS retry instead. */
const LOCK_TIMEOUT = "5s";

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      return work(createRepositories(em));
    });
  }

  reader(): Repositories {
    return createRepositories(this.orm.em.fork());
  }
}

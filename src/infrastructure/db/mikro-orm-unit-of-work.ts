import type { MikroORM } from "@mikro-orm/postgresql";
import type { Metrics, Repositories, UnitOfWork } from "../../application/ports";
import { lockConflictOf } from "../transient-errors";
import { createRepositories } from "./repositories";

/** Waiting longer on a hot wallet only holds a pooled connection: the caller gets a 503 or an SQS retry instead. */
const LOCK_TIMEOUT = "5s";

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Pick<Metrics, "lockConflict">,
  ) {}

  /** Conflicts are counted here because every path to a wallet lock goes through this method. */
  async transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        return work(createRepositories(em));
      });
    } catch (error) {
      const conflict = lockConflictOf(error);
      if (conflict) this.metrics.lockConflict(conflict);
      throw error;
    }
  }

  reader(): Repositories {
    return createRepositories(this.orm.em.fork());
  }
}

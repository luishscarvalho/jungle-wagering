import { join } from "node:path";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { ENTITY_SCHEMAS } from "./schemas";

export function createOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    extensions: [Migrator],
    entities: ENTITY_SCHEMAS,
    migrations: {
      path: join(import.meta.dir, "migrations"),
      // Migrations are hand-written SQL, so there is no entity snapshot to diff.
      snapshot: false,
    },
  });
}

import { join } from "node:path";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

export function createOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    extensions: [Migrator],
    // Entities arrive with the persistence layer; for now only migrations run.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    migrations: {
      path: join(import.meta.dir, "migrations"),
      // Migrations are hand-written SQL, so there is no entity snapshot to diff.
      snapshot: false,
    },
  });
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing required environment variable: DATABASE_URL");
  return url;
}

export default createOrmConfig(requireDatabaseUrl());

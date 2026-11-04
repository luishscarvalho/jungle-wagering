import { createOrmConfig } from "./create-orm-config";

// Entry point for the MikroORM CLI. The app builds its config from APP_CONFIG instead.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Missing required environment variable: DATABASE_URL");

export default createOrmConfig(url);

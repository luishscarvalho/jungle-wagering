import { Global, Module } from "@nestjs/common";
import { type BackoffPolicy, DEFAULT_BACKOFF } from "../domain/shared/backoff";
import { DEFAULT_DB_POOL_MAX } from "./db/create-orm-config";

export const APP_CONFIG = Symbol("APP_CONFIG");

export const ROLES = ["api", "consumer", "outbox", "pending"] as const;
export type Role = (typeof ROLES)[number];

export interface AppConfig {
  port: number;
  databaseUrl: string;
  databasePoolMax: number;
  roles: Role[];
  sqs: {
    region: string;
    endpoint: string;
    queueName: string;
    dlqName: string;
    visibilityTimeoutSeconds: number;
    shutdownGraceMs: number;
  };
  outbox: WorkerConfig & { eventsQueueName: string };
  pending: WorkerConfig;
}

export interface WorkerConfig {
  pollIntervalMs: number;
  backoff: BackoffPolicy;
}

function parseRoles(value: string | undefined): Role[] {
  if (!value?.trim()) return [...ROLES];
  const roles = [...new Set(value.split(",").map((role) => role.trim()))];
  const unknown = roles.filter((role) => !ROLES.includes(role as Role));
  // A typo must not silently start an instance that does less than it was asked to.
  if (unknown.length > 0) throw new Error(`Invalid ROLES: ${unknown.join(", ")}. Expected: ${ROLES.join(", ")}`);
  return roles as Role[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const positiveInteger = (name: string, fallback: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}: ${env[name]}`);
    return value;
  };

  const worker = (prefix: string): WorkerConfig => ({
    pollIntervalMs: positiveInteger(`${prefix}_POLL_INTERVAL_MS`, 500),
    backoff: {
      baseMs: positiveInteger(`${prefix}_BACKOFF_BASE_MS`, DEFAULT_BACKOFF.baseMs),
      maxMs: positiveInteger(`${prefix}_BACKOFF_MAX_MS`, DEFAULT_BACKOFF.maxMs),
    },
  });

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    databaseUrl: required("DATABASE_URL"),
    databasePoolMax: positiveInteger("DB_POOL_MAX", DEFAULT_DB_POOL_MAX),
    roles: parseRoles(env.ROLES),
    sqs: {
      region: required("AWS_REGION"),
      endpoint: required("SQS_ENDPOINT"),
      queueName: required("SQS_QUEUE_NAME"),
      dlqName: env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo",
      visibilityTimeoutSeconds: positiveInteger("SQS_VISIBILITY_TIMEOUT_S", 60),
      shutdownGraceMs: positiveInteger("SQS_SHUTDOWN_GRACE_MS", 10_000),
    },
    outbox: { ...worker("OUTBOX"), eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? "wagering-events.fifo" },
    pending: worker("PENDING"),
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}

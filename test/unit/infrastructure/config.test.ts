import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/infrastructure/config";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  AWS_REGION: "us-east-1",
  SQS_ENDPOINT: "http://localhost:4566",
  SQS_QUEUE_NAME: "wager-transactions.fifo",
};

describe("loadConfig", () => {
  test("defaults PORT to 3000", () => {
    expect(loadConfig(validEnv).port).toBe(3000);
  });

  test("rejects a missing required variable", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: undefined })).toThrow("DATABASE_URL");
  });

  test("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "abc" })).toThrow("PORT");
  });

  test("defaults DB_POOL_MAX to 10 and reads it from the environment", () => {
    expect(loadConfig(validEnv).databasePoolMax).toBe(10);
    expect(loadConfig({ ...validEnv, DB_POOL_MAX: "25" }).databasePoolMax).toBe(25);
  });

  test.each(["0", "-1", "1.5", "abc"])("rejects DB_POOL_MAX=%s", (value) => {
    expect(() => loadConfig({ ...validEnv, DB_POOL_MAX: value })).toThrow("DB_POOL_MAX");
  });

  test.each([undefined, "", "  "])("ROLES=%j means every role", (value) => {
    expect(loadConfig({ ...validEnv, ROLES: value }).roles).toEqual(["api", "consumer", "outbox", "pending"]);
  });

  test("reads a subset of roles, tolerating spaces and repeats", () => {
    expect(loadConfig({ ...validEnv, ROLES: "consumer, api,consumer" }).roles).toEqual(["consumer", "api"]);
  });

  test("rejects an unknown role instead of silently starting less than asked", () => {
    expect(() => loadConfig({ ...validEnv, ROLES: "api,consumerr" })).toThrow("consumerr");
  });

  test("has the worker defaults: base 1s, capped at 60s", () => {
    const backoff = { baseMs: 1000, maxMs: 60_000 };
    expect(loadConfig(validEnv).outbox).toEqual({
      pollIntervalMs: 500,
      backoff,
      eventsQueueName: "wagering-events.fifo",
    });
    expect(loadConfig(validEnv).pending).toEqual({ pollIntervalMs: 500, backoff });
  });

  test("reads each worker's backoff separately", () => {
    const config = loadConfig({ ...validEnv, PENDING_BACKOFF_BASE_MS: "20", PENDING_BACKOFF_MAX_MS: "50" });
    expect(config.pending.backoff).toEqual({ baseMs: 20, maxMs: 50 });
    expect(config.outbox.backoff.baseMs).toBe(1000);
  });

  test("rejects an invalid backoff", () => {
    expect(() => loadConfig({ ...validEnv, OUTBOX_BACKOFF_BASE_MS: "0" })).toThrow("OUTBOX_BACKOFF_BASE_MS");
  });

  test("has the SQS consumer defaults", () => {
    expect(loadConfig(validEnv).sqs).toMatchObject({
      dlqName: "wager-transactions-dlq.fifo",
      visibilityTimeoutSeconds: 60,
      shutdownGraceMs: 10_000,
    });
  });
});

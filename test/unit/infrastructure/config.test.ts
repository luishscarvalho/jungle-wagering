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

  test("has the SQS consumer defaults", () => {
    expect(loadConfig(validEnv).sqs).toMatchObject({
      dlqName: "wager-transactions-dlq.fifo",
      visibilityTimeoutSeconds: 60,
      shutdownGraceMs: 10_000,
    });
  });
});

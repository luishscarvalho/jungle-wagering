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
});

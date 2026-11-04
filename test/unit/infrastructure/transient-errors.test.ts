import { describe, expect, test } from "bun:test";
import { DeadlockException, DriverException } from "@mikro-orm/core";
import { DuplicateTransactionError } from "../../../src/application/ports";
import { isTransientInfrastructureError, lockConflictOf } from "../../../src/infrastructure/transient-errors";

function withCode(code: string, message = "failed"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isTransientInfrastructureError", () => {
  test.each(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"])(
    "network error %s is transient",
    (code) => {
      expect(isTransientInfrastructureError(withCode(code))).toBe(true);
    },
  );

  test.each([
    ["08006", "connection failure"],
    ["53300", "too many connections"],
    ["57P01", "admin shutdown"],
    ["57P03", "cannot connect now"],
    ["40001", "serialization failure"],
    ["40P01", "deadlock"],
    ["55P03", "lock not available"],
  ])("SQLSTATE %s (%s) is transient", (code) => {
    expect(isTransientInfrastructureError(withCode(code))).toBe(true);
  });

  test("the DriverException MikroORM wraps a refused connection in is transient", () => {
    expect(isTransientInfrastructureError(new DriverException(withCode("ECONNREFUSED")))).toBe(true);
  });

  test("a MikroORM deadlock is transient", () => {
    expect(isTransientInfrastructureError(new DeadlockException(new Error("deadlock")))).toBe(true);
  });

  test.each([
    "Connection terminated unexpectedly",
    "terminating connection due to administrator command",
    "timeout exceeded when trying to connect",
  ])("a bare error saying %j is transient", (message) => {
    expect(isTransientInfrastructureError(new Error(message))).toBe(true);
  });

  test("a transient cause makes the error transient", () => {
    expect(isTransientInfrastructureError(new Error("wrapped", { cause: withCode("ECONNRESET") }))).toBe(true);
  });

  test.each([
    ["23505", "unique violation"],
    ["23514", "check violation"],
    ["22003", "numeric out of range"],
    ["42P01", "missing table"],
  ])("SQLSTATE %s (%s) is permanent: retrying would fail the same way", (code) => {
    expect(isTransientInfrastructureError(withCode(code))).toBe(false);
  });

  test.each([[new Error("boom")], ["text"], [undefined], [null]])("%p is not transient", (value) => {
    expect(isTransientInfrastructureError(value)).toBe(false);
  });
});

describe("lockConflictOf", () => {
  test("names the contention, also when the driver error is wrapped", () => {
    const code = (value: string) => Object.assign(new Error("driver"), { code: value });
    expect(lockConflictOf(code("55P03"))).toBe("lock_timeout");
    expect(lockConflictOf(code("40P01"))).toBe("deadlock");
    expect(lockConflictOf(new Error("wrapped", { cause: code("55P03") }))).toBe("lock_timeout");
    expect(lockConflictOf(new DuplicateTransactionError())).toBe("unique_race");
  });

  test("anything else is no conflict", () => {
    expect(lockConflictOf(new Error("boom"))).toBeUndefined();
    expect(lockConflictOf(Object.assign(new Error("x"), { code: "23505" }))).toBeUndefined();
    expect(lockConflictOf("text")).toBeUndefined();
  });
});

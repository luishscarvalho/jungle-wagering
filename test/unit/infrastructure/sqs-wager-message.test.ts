import { describe, expect, test } from "bun:test";
import { MalformedMessageError, parseWagerMessage } from "../../../src/infrastructure/sqs/wager-message";

const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: "msg-1",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: { idempotencyKey: "k", walletId: "w", money: { amount: "1.00", currency: "BRL" } },
    ...overrides,
  });

describe("parseWagerMessage", () => {
  test("accepts the contract's envelope", () => {
    const parsed = parseWagerMessage(envelope());
    expect(parsed.messageId).toBe("msg-1");
    expect(parsed.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["not JSON", "{oops"],
    ["empty", ""],
    ["undefined", undefined],
    ["a JSON array", "[]"],
    ["a JSON null", "null"],
    ["no messageId", envelope({ messageId: undefined })],
    ["a numeric messageId", envelope({ messageId: 1 })],
    ["an empty messageId", envelope({ messageId: "" })],
    ["a messageId with NUL", envelope({ messageId: "a\0b" })],
    ["an oversized messageId", envelope({ messageId: "x".repeat(256) })],
    ["another type", envelope({ type: "SomethingElse" })],
    ["an invalid occurredAt", envelope({ occurredAt: "yesterday" })],
    ["no data", envelope({ data: undefined })],
    ["array data", envelope({ data: [] })],
  ])("rejects %s", (_label, body) => {
    expect(() => parseWagerMessage(body)).toThrow(MalformedMessageError);
  });

  test("the hash ignores key order and transport fields", () => {
    const a = parseWagerMessage(envelope({ data: { a: 1, b: { c: 2, d: 3 } } }));
    const b = parseWagerMessage(envelope({ data: { b: { d: 3, c: 2 }, a: 1 }, occurredAt: "2027-01-01T00:00:00.000Z" }));
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  test("the hash changes with the idempotency key: it is a different message", () => {
    const a = parseWagerMessage(envelope({ data: { idempotencyKey: "k1" } }));
    const b = parseWagerMessage(envelope({ data: { idempotencyKey: "k2" } }));
    expect(a.payloadHash).not.toBe(b.payloadHash);
  });
});

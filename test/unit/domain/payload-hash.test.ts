import { describe, expect, test } from "bun:test";
import { canonicalJson, computePayloadHash, type PayloadHashFields } from "../../../src/domain/transaction/payload-hash";

const fields: PayloadHashFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("sorts keys and has no whitespace", () => {
    expect(canonicalJson({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
  });

  test("sorts keys recursively", () => {
    expect(canonicalJson({ z: { y: "1", x: { b: "2", a: "3" } }, a: "0" })).toBe(
      '{"a":"0","z":{"x":{"a":"3","b":"2"},"y":"1"}}',
    );
  });

  test("sorts keys inside arrays but keeps the array order", () => {
    expect(canonicalJson({ list: [{ b: "1", a: "2" }, "x"] })).toBe('{"list":[{"a":"2","b":"1"},"x"]}');
  });

  test("omits undefined and null fields", () => {
    expect(canonicalJson({ a: "1", b: undefined, c: null })).toBe('{"a":"1"}');
  });

  test("omits absent fields at any depth", () => {
    expect(canonicalJson({ a: { b: undefined, c: "1" } })).toBe('{"a":{"c":"1"}}');
  });

  test("keeps falsy values that are present", () => {
    expect(canonicalJson({ a: "", b: 0, c: false })).toBe('{"a":"","b":0,"c":false}');
  });

  test("escapes strings", () => {
    expect(canonicalJson({ a: 'x"y' })).toBe('{"a":"x\\"y"}');
  });
});

describe("computePayloadHash", () => {
  test("matches a SHA-256 computed outside this code", () => {
    expect(computePayloadHash(fields)).toBe("629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344");
  });

  test("is not affected by key order, at the top level or inside money", () => {
    const reordered: PayloadHashFields = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: fields.gameId,
      roundId: fields.roundId,
      walletId: fields.walletId,
      playerId: fields.playerId,
      externalTransactionId: fields.externalTransactionId,
      providerId: fields.providerId,
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(fields));
  });

  test("omits an absent reference: undefined, null and missing hash the same", () => {
    const hash = computePayloadHash(fields);
    expect(computePayloadHash({ ...fields, referenceExternalTransactionId: undefined })).toBe(hash);
    expect(computePayloadHash({ ...fields, referenceExternalTransactionId: null })).toBe(hash);
  });

  test("includes a reference that is present", () => {
    expect(computePayloadHash({ ...fields, referenceExternalTransactionId: "ext" })).not.toBe(
      computePayloadHash(fields),
    );
  });

  test("ignores the idempotency key and transport metadata", () => {
    const wider = { ...fields, idempotencyKey: "any", messageId: "m", occurredAt: "now", money: { ...fields.money, x: "y" } };
    expect(computePayloadHash(wider)).toBe(computePayloadHash(fields));
  });

  test.each([
    ["providerId", { providerId: "other" }],
    ["externalTransactionId", { externalTransactionId: "other" }],
    ["playerId", { playerId: "other" }],
    ["walletId", { walletId: "other" }],
    ["roundId", { roundId: "other" }],
    ["gameId", { gameId: "other" }],
    ["kind", { kind: "WIN" }],
    ["money amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["money currency", { money: { amount: "25.00", currency: "USD" } }],
    ["referenceExternalTransactionId", { referenceExternalTransactionId: "other" }],
  ])("changes when %s changes", (_label, overrides) => {
    expect(computePayloadHash({ ...fields, ...overrides })).not.toBe(computePayloadHash(fields));
  });

  test("is lowercase hex with 64 characters", () => {
    expect(computePayloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });
});

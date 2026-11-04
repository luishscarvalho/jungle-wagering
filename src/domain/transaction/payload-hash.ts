import { createHash } from "node:crypto";
import type { MoneyProps } from "../money/money";

export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { [key: string]: JsonValue };

/** JSON with object keys sorted recursively, no whitespace, absent fields omitted. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: JsonValue) => canonicalJson(item ?? null)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as { [key: string]: JsonValue };
    const members = Object.keys(object)
      .filter((key) => object[key] !== undefined && object[key] !== null)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 hex of the canonical JSON of the business fields. Fields are picked by
 * name, so idempotencyKey and transport metadata cannot leak into the hash even
 * when the caller passes a wider object.
 */
export function computePayloadHash(fields: PayloadHashFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

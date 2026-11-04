import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "../../domain/transaction/payload-hash";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

const MAX_MESSAGE_ID_LENGTH = 255;

export interface WagerMessage {
  messageId: string;
  /** SHA-256 of the canonical `data`, idempotencyKey included: changing the key changes the message. */
  payloadHash: string;
  /** Untrusted: the use case validates it, as it does for the HTTP body. */
  data: Record<string, unknown>;
}

export class MalformedMessageError extends Error {
  override readonly name = "MalformedMessageError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the envelope only. @throws MalformedMessageError */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    throw new MalformedMessageError("Body is not JSON");
  }
  if (!isObject(parsed)) throw new MalformedMessageError("Body is not a JSON object");

  const { messageId, type, occurredAt, data } = parsed;
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    messageId.length > MAX_MESSAGE_ID_LENGTH ||
    messageId.includes("\0")
  ) {
    throw new MalformedMessageError("messageId is missing or invalid");
  }
  if (type !== WAGER_MESSAGE_TYPE) throw new MalformedMessageError("type is not supported");
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new MalformedMessageError("occurredAt is missing or invalid");
  }
  if (!isObject(data)) throw new MalformedMessageError("data is not a JSON object");

  const payloadHash = createHash("sha256")
    .update(canonicalJson(data as JsonValue))
    .digest("hex");
  return { messageId, payloadHash, data };
}

import { Money } from "../domain/money/money";
import { FailureCode } from "../domain/shared/failure-code";
import { RefusedError } from "./refused-error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 255;
/** NUMERIC(20,2) holds up to 20 digits, counted here in cents. */
const MINOR_UNITS_LIMIT = 10n ** 20n;

function invalid(message: string): RefusedError {
  return new RefusedError(FailureCode.InvalidPayload, message);
}

/** Postgres rejects NUL in text, so it is refused here as bad input instead of failing as a server error. */
export function parseText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH || value.includes("\0")) {
    throw invalid(`${field} must be a non-empty string of up to ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

/** Lowercased because Postgres returns UUIDs that way, and they are compared and hashed as text. */
export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function parseMoney(value: unknown, field: string): Money {
  if (typeof value !== "object" || value === null) {
    throw invalid(`${field} must be an object with amount and currency`);
  }
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  const money = Money.from({ amount: amount as string, currency: currency as string });
  if (money.minorUnits >= MINOR_UNITS_LIMIT) {
    throw invalid(`${field} is too large`);
  }
  return money;
}

export function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

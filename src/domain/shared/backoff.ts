const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

/** Delay before retry number `retry` (1-based): 1s, 2s, 4s, ... capped at 60s. */
export function backoffDelayMs(retry: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (retry - 1), MAX_DELAY_MS);
}

export function nextAttemptAfter(now: Date, retry: number): Date {
  return new Date(now.getTime() + backoffDelayMs(retry));
}

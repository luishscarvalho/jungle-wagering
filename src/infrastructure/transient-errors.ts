import { ConnectionException, DeadlockException, LockWaitTimeoutException } from "@mikro-orm/core";

const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]);

/**
 * SQLSTATE values worth retrying: 08 connection, 53 insufficient resources,
 * 57P0x server shutting down, 40 serialization or deadlock, 55P03 lock timeout.
 */
const TRANSIENT_SQLSTATE = /^(08|53|57P0|40|55P03)/;

/** The pool and driver raise these with no code at all. */
const TRANSIENT_MESSAGE = /connection terminated|terminating connection|timeout exceeded when trying to connect/i;

/**
 * Whether the caller should retry. Checks codes as well as exception classes
 * because MikroORM wraps connection failures as a plain DriverException, and some
 * reach the app as a bare Error from the pool.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || TRANSIENT_SQLSTATE.test(code))) return true;
  if (TRANSIENT_MESSAGE.test(error.message)) return true;
  return error.cause !== undefined && isTransientInfrastructureError(error.cause);
}

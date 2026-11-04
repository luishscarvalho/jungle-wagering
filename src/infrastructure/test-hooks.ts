export const SIMULATED_CRASH_EXIT_CODE = 99;

/**
 * Dies on the spot, with no shutdown hooks, so process tests can place a crash exactly
 * between two steps. Does nothing unless the variable is set to 1.
 */
export function crashIfRequested(flag: "TEST_CRASH_AFTER_COMMIT" | "TEST_CRASH_AFTER_PUBLISH"): void {
  if (process.env[flag] === "1") process.exit(SIMULATED_CRASH_EXIT_CODE);
}

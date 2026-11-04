import type { AppLogger } from "../../application/ports";
import { backoffDelayMs } from "../../domain/shared/backoff";
import { describeError } from "../transient-errors";

export interface PollingWorkerOptions {
  name: string;
  pollIntervalMs: number;
  shutdownGraceMs: number;
}

/** Runs rounds until stopped: right away after progress, after the interval when idle, with backoff after a failure. */
export class PollingWorker {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    /** Resolves to whether there may be more work right now. */
    private readonly round: () => Promise<boolean>,
    private readonly logger: AppLogger,
    private readonly options: PollingWorkerOptions,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  /** The round in progress finishes if it can within the grace period. Past that, its transaction rolls back. */
  async stop(): Promise<void> {
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.shutdownGraceMs);
    });
    await Promise.race([this.loop, graceOver]);
    clearTimeout(timer);
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const more = await this.round();
        failures = 0;
        if (!more) await this.pause(this.options.pollIntervalMs);
      } catch (error) {
        failures += 1;
        this.logger.error("Worker round failed", { worker: this.options.name, failures, ...describeError(error) });
        await this.pause(backoffDelayMs(failures));
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener("abort", done);
    });
  }
}

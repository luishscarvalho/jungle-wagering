import { Logger } from "@nestjs/common";
import { randomUUIDv7 } from "bun";
import type { AppLogger, Clock, IdGenerator } from "../application/ports";

export const uuidV7Generator: IdGenerator = { next: () => randomUUIDv7() };

export const systemClock: Clock = { now: () => new Date() };

/** Structured: main.ts sets Nest's logger to JSON, so each call is one JSON line. */
export class NestAppLogger implements AppLogger {
  private readonly logger = new Logger("Application");

  info(message: string, context: Record<string, unknown>): void {
    this.logger.log({ message, ...context });
  }

  warn(message: string, context: Record<string, unknown>): void {
    this.logger.warn({ message, ...context });
  }

  error(message: string, context: Record<string, unknown>): void {
    this.logger.error({ message, ...context });
  }
}

import { Logger } from "@nestjs/common";
import { randomUUIDv7 } from "bun";
import type { AppLogger, Clock, IdGenerator } from "../application/ports";

export const uuidV7Generator: IdGenerator = { next: () => randomUUIDv7() };

export const systemClock: Clock = { now: () => new Date() };

export class NestAppLogger implements AppLogger {
  private readonly logger = new Logger("Application");

  warn(message: string, context: Record<string, unknown>): void {
    this.logger.warn(`${message} ${JSON.stringify(context)}`);
  }
}

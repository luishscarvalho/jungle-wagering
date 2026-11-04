import { Controller, Get, Logger, ServiceUnavailableException } from "@nestjs/common";
import { PostgresHealthCheck, SqsHealthCheck } from "./health.checks";

const CHECK_TIMEOUT_MS = 3000;

type CheckStatus = "up" | "down";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly postgres: PostgresHealthCheck,
    private readonly sqs: SqsHealthCheck,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const [postgres, sqs] = await Promise.all([
      this.run("postgres", () => this.postgres.check()),
      this.run("sqs", () => this.sqs.check()),
    ]);
    const checks = { postgres, sqs };

    if (postgres === "down" || sqs === "down") {
      throw new ServiceUnavailableException({ status: "error", checks });
    }
    return { status: "ok", checks };
  }

  // Failure details go to the logs only, since this endpoint is unauthenticated.
  private async run(name: string, check: () => Promise<void>): Promise<CheckStatus> {
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
    });

    try {
      await Promise.race([check(), timeout]);
      return "up";
    } catch (error) {
      this.logger.warn(`${name} readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      return "down";
    } finally {
      clearTimeout(timer);
    }
  }
}

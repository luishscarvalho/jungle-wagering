import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PostgresHealthCheck, SqsHealthCheck } from "../../../../../src/infrastructure/http/health/health.checks";
import { HealthController } from "../../../../../src/infrastructure/http/health/health.controller";

type Check = () => Promise<void>;
const up: Check = async () => {};
const down: Check = async () => {
  throw new Error("boom");
};

let app: INestApplication;

async function start(postgres: Check, sqs: Check): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: PostgresHealthCheck, useValue: { check: postgres } },
      { provide: SqsHealthCheck, useValue: { check: sqs } },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

afterEach(() => app.close());

describe("GET /health/live", () => {
  test("is 200 even with dependencies down", async () => {
    const url = await start(down, down);
    const res = await fetch(`${url}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /health/ready", () => {
  test("is 200 when all dependencies are up", async () => {
    const url = await start(up, up);
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
  });

  test("is 503 when postgres is down", async () => {
    const url = await start(down, up);
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", failureCode: "INFRASTRUCTURE_UNAVAILABLE", checks: { postgres: "down", sqs: "up" } });
  });

  test("is 503 when sqs is down", async () => {
    const url = await start(up, down);
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", failureCode: "INFRASTRUCTURE_UNAVAILABLE", checks: { postgres: "up", sqs: "down" } });
  });

  test("is 503 when a check hangs", async () => {
    const url = await start(() => new Promise(() => {}), up);
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", failureCode: "INFRASTRUCTURE_UNAVAILABLE", checks: { postgres: "down", sqs: "up" } });
  }, 5000);
});

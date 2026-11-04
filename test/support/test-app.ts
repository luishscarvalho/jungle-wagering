import "reflect-metadata";
import { expect } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUIDv7, type SQL } from "bun";
import { AppModule } from "../../src/app.module";
import { APP_CONFIG, type AppConfig, type Role } from "../../src/infrastructure/config";

export interface TestApp {
  app: INestApplication;
  url: string;
}

/** The real AppModule on a random port. Each call is one instance, with its own connection pool. */
export async function startTestApp(
  databaseUrl: string,
  options: { roles?: Role[]; sqs?: Partial<AppConfig["sqs"]> } = {},
): Promise<TestApp> {
  const roles = options.roles ?? ["api"];
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    databasePoolMax: 10,
    roles,
    sqs: {
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      queueName: "wager-transactions.fifo",
      dlqName: "wager-transactions-dlq.fifo",
      visibilityTimeoutSeconds: 60,
      shutdownGraceMs: 10_000,
      ...options.sqs,
    },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoles(roles)] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, "127.0.0.1");
  return { app, url: await app.getUrl() };
}

export interface HttpResult {
  status: number;
  // biome-ignore lint: tests read arbitrary response fields
  body: any;
}

export async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

export interface TestWallet {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export async function createWallet(baseUrl: string, amount = "100.00", currency = "BRL"): Promise<TestWallet> {
  const result = await request(baseUrl, "POST", "/wallets", {
    playerId: randomUUIDv7(),
    initialBalance: { amount, currency },
  });
  expect(result.status).toBe(201);
  return result.body;
}

export function wagerBody(wallet: TestWallet, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: wallet.balance.currency },
    ...overrides,
  };
}

export function submit(baseUrl: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<HttpResult> {
  const key = idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`;
  return request(baseUrl, "POST", "/wagering/transactions", body, { "idempotency-key": key });
}

/**
 * The final invariant of every test: the stored balance equals the one rebuilt from
 * the ledger, and each entry starts where the previous one ended.
 */
export async function expectBalanceMatchesLedger(sql: SQL, walletId: string, expectedBalance?: string): Promise<void> {
  const [row] = await sql`
    SELECT w.balance,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(30,2) AS rebuilt
      FROM wallets w
      LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     WHERE w.id = ${walletId}
     GROUP BY w.id
  `;
  expect(row.rebuilt).toBe(row.balance);
  if (expectedBalance !== undefined) expect(row.balance).toBe(expectedBalance);

  const entries = await sql`
    SELECT balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY id
  `;
  let previousAfter = "0.00";
  for (const entry of entries) {
    expect(entry.balance_before).toBe(previousAfter);
    previousAfter = entry.balance_after;
  }
}

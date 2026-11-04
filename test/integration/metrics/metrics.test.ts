import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL } from "bun";
import { PublishOutbox } from "../../../src/application/outbox/publish-outbox";
import { type AppLogger, CLOCK, METRICS, UNIT_OF_WORK } from "../../../src/application/ports";
import { ProcessWagerTransaction } from "../../../src/application/wager/process-wager-transaction";
import { WagerConsumer } from "../../../src/infrastructure/sqs/wager-consumer";
import {
  createSqsClient,
  createTestQueues,
  eventually,
  readDlq,
  sendMessage,
  sendRaw,
  type TestQueues,
  wagerMessage,
} from "../../support/sqs";
import {
  createWallet,
  metricValue,
  request,
  startTestApp,
  submit,
  type TestApp,
  wagerBody,
} from "../../support/test-app";
import { createTestDatabase, type TestDatabase } from "../db/support";

let db: TestDatabase;
let sql: SQL;
let testApp: TestApp;
let url: string;
const cleanups: (() => Promise<unknown>)[] = [];

const silent: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
  testApp = await startTestApp(db.url);
  url = testApp.url;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  await testApp.app.close();
  await db.drop();
});

/** How much a sample grew while `action` ran. */
async function growth(name: string, labels: Record<string, string>, action: () => Promise<unknown>): Promise<number> {
  const before = await metricValue(url, name, labels);
  await action();
  return (await metricValue(url, name, labels)) - before;
}

function startConsumer(queues: TestQueues, useCase = testApp.app.get(ProcessWagerTransaction)) {
  const consumer = new WagerConsumer(createSqsClient(), useCase, silent, testApp.app.get(METRICS), {
    queueName: queues.queueName,
    dlqName: queues.dlqName,
    visibilityTimeoutSeconds: 60,
    shutdownGraceMs: 10_000,
  });
  consumer.start();
  return consumer;
}

async function queuesForTest(): Promise<TestQueues> {
  const queues = await createTestQueues();
  cleanups.push(() => queues.drop());
  return queues;
}

describe("GET /metrics", () => {
  test("is open and in the Prometheus text format, with every metric", async () => {
    const response = await fetch(`${url}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    for (const name of [
      "wagering_transactions_total",
      "wagering_refusals_total",
      "wagering_duplicates_total",
      "wagering_retries_total",
      "wagering_dlq_messages_total",
      "wagering_lock_conflicts_total",
      "wagering_outbox_lag_seconds",
      "wagering_processing_duration_seconds",
      "wagering_reconciliation_divergences_total",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  test("exists in an instance without the api role, which has no business routes", async () => {
    const worker = await startTestApp(db.url, { roles: ["pending"] });
    cleanups.push(() => worker.app.close());

    expect((await fetch(`${worker.url}/metrics`)).status).toBe(200);
    expect((await fetch(`${worker.url}/wallets/${randomUUIDv7()}`)).status).toBe(404);
  });
});

describe("transactions by status and kind", () => {
  const transactions = (status: string, kind: string) =>
    ["wagering_transactions_total", { status, kind }] as const;

  test("a wallet with an initial balance counts its OPENING; an empty one counts nothing", async () => {
    expect(await growth(...transactions("PROCESSED", "OPENING"), () => createWallet(url, "10.00"))).toBe(1);
    expect(await growth(...transactions("PROCESSED", "OPENING"), () => createWallet(url, "0.00"))).toBe(0);
  });

  test("each outcome goes to its own series", async () => {
    const wallet = await createWallet(url, "100.00");

    expect(await growth(...transactions("PROCESSED", "BET"), () => submit(url, wagerBody(wallet)))).toBe(1);
    expect(
      await growth(...transactions("REJECTED", "BET"), () =>
        submit(url, wagerBody(wallet, { money: { amount: "500.00", currency: "BRL" } })),
      ),
    ).toBe(1);
    expect(
      await growth(...transactions("PENDING_REFERENCE", "REFUND"), () =>
        submit(url, wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: `missing-${randomUUIDv7()}` })),
      ),
    ).toBe(1);
    expect(
      await growth(...transactions("PROCESSED", "LOSS"), () =>
        submit(url, wagerBody(wallet, { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } })),
      ),
    ).toBe(1);
  });

  test("a refusal writes no transaction and goes to its own counter", async () => {
    const wallet = await createWallet(url, "100.00");
    const before = await metricValue(url, "wagering_transactions_total", { status: "PROCESSED", kind: "BET" });

    const code = await growth("wagering_refusals_total", { failure_code: "PLAYER_MISMATCH" }, () =>
      submit(url, wagerBody(wallet, { playerId: randomUUIDv7() })),
    );

    expect(code).toBe(1);
    expect(await metricValue(url, "wagering_transactions_total", { status: "PROCESSED", kind: "BET" })).toBe(before);
  });
});

describe("duplicates", () => {
  test("an HTTP replay counts as a duplicate and not as a new transaction", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet);
    await submit(url, body);
    const processedBefore = await metricValue(url, "wagering_transactions_total", { status: "PROCESSED", kind: "BET" });

    expect(await growth("wagering_duplicates_total", { source: "http_replay" }, () => submit(url, body))).toBe(1);

    expect(await metricValue(url, "wagering_transactions_total", { status: "PROCESSED", kind: "BET" })).toBe(
      processedBefore,
    );
  });

  test("the same message twice hits the inbox; a new message with a known key is a replay", async () => {
    const wallet = await createWallet(url, "100.00");
    const useCase = testApp.app.get(ProcessWagerTransaction);
    const message = wagerMessage(wallet);
    const run = (messageId: string) =>
      useCase.execute({
        idempotencyKey: message.data.idempotencyKey,
        payload: message.data,
        inbox: { messageId, consumerName: "metrics-test", payloadHash: "same" },
      });
    await run(message.messageId);

    expect(await growth("wagering_duplicates_total", { source: "inbox" }, () => run(message.messageId))).toBe(1);
    expect(await growth("wagering_duplicates_total", { source: "sqs_replay" }, () => run(randomUUIDv7()))).toBe(1);
  });
});

describe("retries and the DLQ", () => {
  test("a failed outbox publish counts as a retry", async () => {
    const wallet = await createWallet(url, "100.00");
    await sql`UPDATE outbox_messages SET published_at = now() WHERE aggregate_id <> ${wallet.id} AND published_at IS NULL`;
    const outbox = new PublishOutbox(
      testApp.app.get(UNIT_OF_WORK),
      {
        publish: async () => {
          throw new Error("broker down");
        },
      },
      testApp.app.get(CLOCK),
      silent,
      testApp.app.get(METRICS),
    );

    expect(await growth("wagering_retries_total", { source: "outbox" }, () => outbox.runRound())).toBe(1);
  });

  test("a transient failure in the consumer counts as a retry", async () => {
    const queues = await queuesForTest();
    const wallet = await createWallet(url, "100.00");
    const real = testApp.app.get(ProcessWagerTransaction);
    let calls = 0;
    const flaky = {
      execute: (input: Parameters<ProcessWagerTransaction["execute"]>[0]) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return real.execute(input);
      },
    } as ProcessWagerTransaction;
    const before = await metricValue(url, "wagering_retries_total", { source: "sqs" });

    const consumer = startConsumer(queues, flaky);
    cleanups.push(() => consumer.stop());
    await sendMessage(queues, wagerMessage(wallet));

    await eventually(
      () => metricValue(url, "wagering_retries_total", { source: "sqs" }),
      (value) => value === before + 1,
    );
  });

  test("a malformed message counts in the DLQ metric, by reason", async () => {
    const queues = await queuesForTest();
    const before = await metricValue(url, "wagering_dlq_messages_total", { reason: "MALFORMED_MESSAGE" });
    const consumer = startConsumer(queues);
    cleanups.push(() => consumer.stop());

    await sendRaw(queues, "not json", randomUUIDv7());

    await eventually(
      () => metricValue(url, "wagering_dlq_messages_total", { reason: "MALFORMED_MESSAGE" }),
      (value) => value === before + 1,
    );
    expect(await readDlq(queues)).toHaveLength(1);
  });
});

describe("lock conflicts", () => {
  test(
    "a wallet held past lock_timeout answers 503 and counts",
    async () => {
      const wallet = await createWallet(url, "100.00");
      const before = await metricValue(url, "wagering_lock_conflicts_total", { kind: "lock_timeout" });

      const result = await sql.begin(async (tx) => {
        await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
        return submit(url, wagerBody(wallet));
      });

      expect(result.status).toBe(503);
      expect(await metricValue(url, "wagering_lock_conflicts_total", { kind: "lock_timeout" })).toBe(before + 1);
    },
    15_000,
  );
});

describe("outbox lag", () => {
  test("is the age of the oldest unpublished event, and 0 when nothing is pending", async () => {
    await sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
    expect(await metricValue(url, "wagering_outbox_lag_seconds")).toBe(0);

    const wallet = await createWallet(url, "100.00");
    await sql`UPDATE outbox_messages SET occurred_at = now() - interval '1 hour' WHERE aggregate_id = ${wallet.id}`;

    const lag = await metricValue(url, "wagering_outbox_lag_seconds");
    expect(lag).toBeGreaterThanOrEqual(3600);
    expect(lag).toBeLessThan(3660);

    await sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
    expect(await metricValue(url, "wagering_outbox_lag_seconds")).toBe(0);
  });
});

describe("latency", () => {
  test("each processed operation lands in the histogram of its entry", async () => {
    const wallet = await createWallet(url, "100.00");
    const growthOfCount = await growth("wagering_processing_duration_seconds_count", { entry: "http" }, () =>
      submit(url, wagerBody(wallet)),
    );

    expect(growthOfCount).toBe(1);
    expect(await metricValue(url, "wagering_processing_duration_seconds_sum", { entry: "http" })).toBeGreaterThan(0);
  });
});

describe("reconciliation", () => {
  test("a divergence counts, and a consistent wallet does not", async () => {
    const wallet = await createWallet(url, "100.00");
    const reconcile = () => request(url, "POST", `/wallets/${wallet.id}/reconciliation`);

    expect(await growth("wagering_reconciliation_divergences_total", {}, reconcile)).toBe(0);

    await sql`UPDATE wallets SET balance = 90.00 WHERE id = ${wallet.id}`;
    let report: Awaited<ReturnType<typeof reconcile>> | undefined;
    const counted = await growth("wagering_reconciliation_divergences_total", {}, async () => {
      report = await reconcile();
    });

    expect(counted).toBe(1);
    expect(report?.body.consistent).toBe(false);
  });
});

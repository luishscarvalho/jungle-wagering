import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { randomUUIDv7, type SQL } from "bun";
import type { AppLogger } from "../../../src/application/ports";
import { ProcessWagerTransaction } from "../../../src/application/wager/process-wager-transaction";
import { WAGER_CONSUMER_NAME, WagerConsumer } from "../../../src/infrastructure/sqs/wager-consumer";
import {
  createSqsClient,
  createTestQueues,
  eventually,
  queueCounts,
  readDlq,
  sendMessage,
  sendRaw,
  type TestQueues,
  wagerMessage,
} from "../../support/sqs";
import {
  createWallet,
  expectBalanceMatchesLedger,
  request,
  startTestApp,
  type TestApp,
  type TestWallet,
} from "../../support/test-app";
import { createTestDatabase, type TestDatabase } from "../db/support";

const LONG = { timeout: 60_000 };

let db: TestDatabase;
let sql: SQL;
let testApp: TestApp;
let url: string;

const cleanups: (() => Promise<unknown>)[] = [];

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

async function queuesFor(maxReceiveCount = 5): Promise<TestQueues> {
  const queues = await createTestQueues(maxReceiveCount);
  cleanups.push(() => queues.drop());
  return queues;
}

interface LogLine {
  level: string;
  message: string;
  context: Record<string, unknown>;
}

interface ConsumerOptions {
  useCase?: Pick<ProcessWagerTransaction, "execute">;
  client?: SQSClient;
  visibilityTimeoutSeconds?: number;
}

/** A real consumer on real queues. It is stopped, and its queues dropped, after the test. */
function startConsumer(queues: TestQueues, options: ConsumerOptions = {}) {
  const logs: LogLine[] = [];
  const at = (level: string) => (message: string, context: Record<string, unknown>) => {
    logs.push({ level, message, context });
  };
  const logger: AppLogger = { info: at("info"), warn: at("warn"), error: at("error") };
  const consumer = new WagerConsumer(
    options.client ?? createSqsClient(),
    (options.useCase ?? testApp.app.get(ProcessWagerTransaction)) as ProcessWagerTransaction,
    logger,
    {
      queueName: queues.queueName,
      dlqName: queues.dlqName,
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 60,
      shutdownGraceMs: 10_000,
    },
  );
  consumer.start();
  cleanups.push(() => consumer.stop());
  return { consumer, logs };
}

/** Fails the first `times` calls with `error`, then goes through to the real use case. */
function failingUseCase(times: number, error: Error) {
  const real = testApp.app.get(ProcessWagerTransaction);
  const calls = { count: 0 };
  return {
    calls,
    useCase: {
      execute: async (input: Parameters<ProcessWagerTransaction["execute"]>[0]) => {
        calls.count += 1;
        if (calls.count <= times) throw error;
        return real.execute(input);
      },
    },
  };
}

const connectionReset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

const drained = (queues: TestQueues) =>
  eventually(
    () => queueCounts(queues),
    (counts) => counts.visible === 0 && counts.inFlight === 0,
  );

async function inboxRows(messageId: string) {
  return sql`SELECT * FROM inbox_messages WHERE consumer_name = ${WAGER_CONSUMER_NAME} AND message_id = ${messageId}`;
}

async function wagers(walletId: string) {
  return sql`SELECT status, failure_code, amount FROM wager_transactions WHERE wallet_id = ${walletId} AND kind <> 'OPENING' ORDER BY id`;
}

async function ledgerCount(walletId: string): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return row.count;
}

const untilWagers = (walletId: string, count: number) =>
  eventually(
    () => wagers(walletId),
    (rows) => rows.length >= count,
  );

describe("happy path", () => {
  test("applies the message and commits inbox, transaction, ledger and outbox, then acks", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);

    const { logs } = startConsumer(queues);
    await drained(queues);

    expect(await wagers(wallet.id)).toEqual([{ status: "PROCESSED", failure_code: null, amount: "25.00" }]);
    const [inbox] = await inboxRows(message.messageId);
    expect(inbox.processed_at).toBeInstanceOf(Date);
    const [events] = await sql`SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id = ${wallet.id}`;
    expect(events.count).toBeGreaterThanOrEqual(2);
    expect(await readDlq(queues)).toHaveLength(0);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");

    const processed = logs.find((line) => line.message === "Message processed");
    expect(processed?.context).toMatchObject({
      messageId: message.messageId,
      walletId: wallet.id,
      providerId: "provider-a",
      correlationId: message.data.idempotencyKey,
      status: "PROCESSED",
    });
    expect(processed?.context.transactionId).toBeString();
    expect(JSON.stringify(logs)).not.toContain("25.00");
  }, LONG);

  test("keeps the order inside a group across a batch", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    // Applied out of order, the 30.00 would succeed and the 80.00 would be the one rejected.
    await sendMessage(queues, wagerMessage(wallet, { dataOverrides: { money: { amount: "80.00", currency: "BRL" } } }));
    await sendMessage(queues, wagerMessage(wallet, { dataOverrides: { money: { amount: "30.00", currency: "BRL" } } }));

    startConsumer(queues);
    await drained(queues);

    expect((await wagers(wallet.id)).map((row: { status: string }) => row.status)).toEqual(["PROCESSED", "REJECTED"]);
    await expectBalanceMatchesLedger(sql, wallet.id, "20.00");
  }, LONG);

  test("processes different wallets in the same batch", async () => {
    const queues = await queuesFor();
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(url, "100.00")));
    for (const wallet of wallets) await sendMessage(queues, wagerMessage(wallet));

    startConsumer(queues);
    await drained(queues);

    for (const wallet of wallets) await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);
});

describe("redelivery", () => {
  test("the same message delivered again has one effect and is acked", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);
    await sendMessage(queues, message);

    const { logs } = startConsumer(queues);
    await drained(queues);

    expect(await wagers(wallet.id)).toHaveLength(1);
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await inboxRows(message.messageId)).toHaveLength(1);
    expect(logs.filter((line) => line.message === "Duplicate message ignored")).toHaveLength(1);
    expect(await readDlq(queues)).toHaveLength(0);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("copies arriving in parallel on different groups have one effect", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet);
    const body = JSON.stringify(message);
    for (let group = 0; group < 8; group++) await sendRaw(queues, body, `group-${group}`);

    startConsumer(queues);
    await drained(queues);

    expect(await ledgerCount(wallet.id)).toBe(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("dying after the commit and before the ack: the broker redelivers and nothing is applied twice", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);

    const client = createSqsClient();
    const send = client.send.bind(client);
    let lostAcks = 0;
    client.send = ((command: unknown, ...rest: unknown[]) => {
      if (command instanceof DeleteMessageCommand && lostAcks++ === 0) return Promise.reject(new Error("connection lost"));
      return (send as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof client.send;

    const { logs } = startConsumer(queues, { client, visibilityTimeoutSeconds: 1 });
    await drained(queues);

    expect(lostAcks).toBe(2);
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(logs.map((line) => line.message)).toContain("Ack failed, the inbox will absorb the redelivery");
    expect(logs.map((line) => line.message)).toContain("Duplicate message ignored");
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("the same messageId with a different hash goes to the DLQ and changes nothing", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);
    const tampered = wagerMessage(wallet, { messageId: message.messageId });
    await sendMessage(queues, tampered);

    startConsumer(queues);
    await drained(queues);

    const dlq = await readDlq(queues);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.Body).toBe(JSON.stringify(tampered));
    expect(dlq[0]?.MessageAttributes?.failureReason?.StringValue).toBe("MESSAGE_ID_CONFLICT");
    expect(await wagers(wallet.id)).toHaveLength(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);
});

describe("business outcomes and refusals are acked", () => {
  test("insufficient funds: REJECTED, acked, not in the DLQ", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "10.00");
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);

    startConsumer(queues);
    await drained(queues);

    expect(await wagers(wallet.id)).toEqual([
      { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", amount: "25.00" },
    ]);
    expect(await readDlq(queues)).toHaveLength(0);
    expect(await inboxRows(message.messageId)).toHaveLength(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "10.00");
  }, LONG);

  test("a reversal ahead of its reference stays PENDING_REFERENCE and is acked", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    await sendMessage(
      queues,
      wagerMessage(wallet, { dataOverrides: { kind: "REFUND", referenceExternalTransactionId: "not-here-yet" } }),
    );

    startConsumer(queues);
    await drained(queues);

    expect((await wagers(wallet.id))[0]?.status).toBe("PENDING_REFERENCE");
    expect(await readDlq(queues)).toHaveLength(0);
  }, LONG);

  const fakeWallet = (): TestWallet => ({
    id: randomUUIDv7(),
    playerId: randomUUIDv7(),
    balance: { amount: "1.00", currency: "BRL" },
    version: 1,
  });

  test.each([
    ["WALLET_NOT_FOUND", async () => wagerMessage(fakeWallet())],
    ["PLAYER_MISMATCH", async () => wagerMessage(await createWallet(url), { dataOverrides: { playerId: randomUUIDv7() } })],
    [
      "CURRENCY_MISMATCH",
      async () =>
        wagerMessage(await createWallet(url), { dataOverrides: { money: { amount: "1.00", currency: "USD" } } }),
    ],
    ["KIND_NOT_ALLOWED", async () => wagerMessage(await createWallet(url), { dataOverrides: { kind: "OPENING" } })],
  ] as [string, () => Promise<ReturnType<typeof wagerMessage>>][])(
    "refusal %s is recorded in the inbox and acked, with no transaction",
    async (failureCode, build) => {
      const queues = await queuesFor();
      const message = await build();
      await sendMessage(queues, message);

      const { logs } = startConsumer(queues);
      await drained(queues);

      expect(logs.find((line) => line.message === "Message refused")?.context.failureCode).toBe(failureCode);
      expect(await inboxRows(message.messageId)).toHaveLength(1);
      expect(await wagers(message.data.walletId)).toHaveLength(0);
      expect(await readDlq(queues)).toHaveLength(0);
    },
    LONG,
  );

  test("reusing an idempotency key with another payload is a recorded refusal", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const first = wagerMessage(wallet);
    const second = wagerMessage(wallet, { dataOverrides: { walletId: randomUUIDv7() } });
    second.data.idempotencyKey = first.data.idempotencyKey;
    await sendMessage(queues, first);
    await sendRaw(queues, JSON.stringify(second), wallet.id);

    const { logs } = startConsumer(queues);
    await drained(queues);

    expect(logs.find((line) => line.message === "Message refused")?.context.failureCode).toBe("IDEMPOTENCY_CONFLICT");
    expect(await inboxRows(second.messageId)).toHaveLength(1);
    expect(await readDlq(queues)).toHaveLength(0);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);
});

describe("permanent failures go straight to the DLQ", () => {
  test.each([
    ["not JSON", (_wallet: TestWallet) => "{not json"],
    ["an unknown type", (wallet: TestWallet) => JSON.stringify({ ...wagerMessage(wallet), type: "Other" })],
    ["no messageId", (wallet: TestWallet) => JSON.stringify({ ...wagerMessage(wallet), messageId: undefined })],
    [
      "an invalid amount",
      (wallet: TestWallet) =>
        JSON.stringify(wagerMessage(wallet, { dataOverrides: { money: { amount: "abc", currency: "BRL" } } })),
    ],
    ["an unknown kind", (wallet: TestWallet) => JSON.stringify(wagerMessage(wallet, { dataOverrides: { kind: "JACKPOT" } }))],
  ] as [string, (wallet: TestWallet) => string][])(
    "a message with %s is dead-lettered on the first delivery, and nothing is written",
    async (_label, build) => {
      const queues = await queuesFor();
      const wallet = await createWallet(url, "100.00");
      const body = build(wallet);
      await sendRaw(queues, body, wallet.id);

      startConsumer(queues);
      await drained(queues);

      const dlq = await readDlq(queues);
      expect(dlq).toHaveLength(1);
      expect(dlq[0]?.Body).toBe(body);
      expect(dlq[0]?.MessageAttributes?.failureReason?.StringValue).toBeString();
      expect(await wagers(wallet.id)).toHaveLength(0);
      await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
    },
    LONG,
  );

  test("an invalid payload leaves no inbox row, so a crash before the DLQ cannot lose it", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet, { dataOverrides: { kind: "JACKPOT" } });
    await sendMessage(queues, message);

    startConsumer(queues);
    await drained(queues);

    expect(await inboxRows(message.messageId)).toHaveLength(0);
  }, LONG);

  test("an error that retrying cannot fix goes to the DLQ as PROCESSING_FAILED", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const { useCase, calls } = failingUseCase(99, Object.assign(new Error("check violation"), { code: "23514" }));
    await sendMessage(queues, wagerMessage(wallet));

    startConsumer(queues, { useCase });
    await drained(queues);

    expect(calls.count).toBe(1);
    const dlq = await readDlq(queues);
    expect(dlq[0]?.MessageAttributes?.failureReason?.StringValue).toBe("PROCESSING_FAILED");
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  }, LONG);

  test("when the DLQ is unavailable the message is kept, not deleted", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    await sendRaw(queues, "{not json", wallet.id);

    const client = createSqsClient();
    const send = client.send.bind(client);
    let refusedSends = 0;
    client.send = ((command: unknown, ...rest: unknown[]) => {
      if (command instanceof SendMessageCommand && refusedSends++ === 0) return Promise.reject(new Error("DLQ down"));
      return (send as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof client.send;

    startConsumer(queues, { client });
    await drained(queues);

    expect(refusedSends).toBe(2);
    expect(await readDlq(queues)).toHaveLength(1);
  }, LONG);
});

describe("transient failures", () => {
  test("do not delete: the message stays in flight under backoff, then succeeds once", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const message = wagerMessage(wallet);
    const { useCase, calls } = failingUseCase(1, connectionReset());
    await sendMessage(queues, message);

    const { logs } = startConsumer(queues, { useCase });
    await eventually(
      async () => calls.count,
      (count) => count === 1,
    );
    await eventually(
      async () => logs.map((line) => line.message),
      (lines) => lines.includes("Transient failure processing message"),
    );

    expect(await queueCounts(queues)).toEqual({ visible: 0, inFlight: 1 });
    expect(await readDlq(queues)).toHaveLength(0);
    expect(await inboxRows(message.messageId)).toHaveLength(0);
    expect(await wagers(wallet.id)).toHaveLength(0);

    await drained(queues);
    expect(calls.count).toBe(2);
    expect(logs.find((line) => line.message === "Message processed")?.context.receiveCount).toBe(2);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("backoff follows ApproximateReceiveCount: 1s, then 2s", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const { useCase } = failingUseCase(2, connectionReset());
    await sendMessage(queues, wagerMessage(wallet));

    const client = createSqsClient();
    const send = client.send.bind(client);
    const asked: (number | undefined)[] = [];
    client.send = ((command: unknown, ...rest: unknown[]) => {
      if (command instanceof ChangeMessageVisibilityCommand) {
        asked.push(command.input.VisibilityTimeout);
      }
      return (send as (...args: unknown[]) => unknown)(command, ...rest);
    }) as typeof client.send;

    startConsumer(queues, { client, useCase });
    await drained(queues);

    expect(asked).toEqual([1, 2]);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("the rest of the group waits: later messages are not applied ahead of the failed one", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const { useCase } = failingUseCase(1, connectionReset());
    await sendMessage(queues, wagerMessage(wallet, { dataOverrides: { money: { amount: "80.00", currency: "BRL" } } }));
    await sendMessage(queues, wagerMessage(wallet, { dataOverrides: { money: { amount: "30.00", currency: "BRL" } } }));

    startConsumer(queues, { useCase });
    await drained(queues);

    expect((await wagers(wallet.id)).map((row: { status: string }) => row.status)).toEqual(["PROCESSED", "REJECTED"]);
    await expectBalanceMatchesLedger(sql, wallet.id, "20.00");
  }, LONG);

  test("a real lock_timeout is transient: the message is retried and applied once", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const connection = await sql.reserve();
    await connection`BEGIN`;
    await connection`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
    await sendMessage(queues, wagerMessage(wallet));

    const { logs } = startConsumer(queues);
    await eventually(
      async () => logs.map((line) => line.message),
      (lines) => lines.includes("Transient failure processing message"),
    );
    await connection`COMMIT`;
    connection.release();
    await drained(queues);

    expect(await ledgerCount(wallet.id)).toBe(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("after the receive limit the redrive policy takes the message to the DLQ", async () => {
    const queues = await queuesFor(2);
    const wallet = await createWallet(url, "100.00");
    const { useCase, calls } = failingUseCase(Number.MAX_SAFE_INTEGER, connectionReset());
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);

    startConsumer(queues, { useCase });
    const dlq = await eventually(
      () => readDlq(queues),
      (messages) => messages.length === 1,
      30_000,
    );

    expect(dlq[0]?.Body).toBe(JSON.stringify(message));
    expect(calls.count).toBe(2);
    expect(await queueCounts(queues)).toEqual({ visible: 0, inFlight: 0 });
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  }, LONG);
});

describe("SIGTERM", () => {
  interface Instance {
    process: Bun.Subprocess<"ignore", "pipe", "pipe">;
    output: () => Promise<string>;
  }

  function spawnInstance(queues: TestQueues, env: Record<string, string> = {}): Instance {
    const child = Bun.spawn(["bun", "src/main.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        PORT: "0",
        ROLES: "consumer",
        SQS_QUEUE_NAME: queues.queueName,
        SQS_DLQ_NAME: queues.dlqName,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(async () => {
      child.kill("SIGKILL");
      await child.exited;
    });
    return { process: child, output: () => new Response(child.stdout).text() };
  }

  /** Holds the row, so the instance has a message truly in flight, blocked on the wallet lock. */
  async function lockWallet(walletId: string) {
    const connection = await sql.reserve();
    await connection`BEGIN`;
    await connection`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    return async () => {
      await connection`COMMIT`;
      connection.release();
    };
  }

  const blockedOnLock = () =>
    eventually(
      async () => {
        const [row] = await sql`
          SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
        return row.count as number;
      },
      (count) => count >= 1,
    );

  test("idle: the long poll is interrupted and the process exits right away", async () => {
    const queues = await queuesFor();
    const instance = spawnInstance(queues);
    await Bun.sleep(1500);

    const started = performance.now();
    instance.process.kill("SIGTERM");
    await instance.process.exited;

    expect(performance.now() - started).toBeLessThan(5000);
  }, LONG);

  test("finishes the message in flight within the grace period and acks it", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const unlock = await lockWallet(wallet.id);
    await sendMessage(queues, wagerMessage(wallet));
    const instance = spawnInstance(queues);
    await blockedOnLock();

    instance.process.kill("SIGTERM");
    await Bun.sleep(1000);
    expect(instance.process.exitCode).toBeNull();
    await unlock();
    await instance.process.exited;

    expect(await queueCounts(queues)).toEqual({ visible: 0, inFlight: 0 });
    expect(await ledgerCount(wallet.id)).toBe(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);

  test("does not start the next message of the group: it goes back to the queue", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const unlock = await lockWallet(wallet.id);
    await sendMessage(queues, wagerMessage(wallet));
    await sendMessage(queues, wagerMessage(wallet));
    const instance = spawnInstance(queues);
    await blockedOnLock();

    instance.process.kill("SIGTERM");
    await Bun.sleep(500);
    await unlock();
    await instance.process.exited;

    expect(await queueCounts(queues)).toEqual({ visible: 1, inFlight: 0 });
    expect(await ledgerCount(wallet.id)).toBe(1);

    spawnInstance(queues);
    await drained(queues);
    expect(await ledgerCount(wallet.id)).toBe(2);
    await expectBalanceMatchesLedger(sql, wallet.id, "50.00");
  }, LONG);

  test("past the grace period it returns the visibility, and another instance applies the message once", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const unlock = await lockWallet(wallet.id);
    await sendMessage(queues, wagerMessage(wallet));
    const instance = spawnInstance(queues, { SQS_SHUTDOWN_GRACE_MS: "300" });
    await blockedOnLock();
    expect(await queueCounts(queues)).toEqual({ visible: 0, inFlight: 1 });

    instance.process.kill("SIGTERM");
    // Well before the 60s visibility timeout and the 5s lock_timeout: only the release can explain it.
    await eventually(
      () => queueCounts(queues),
      (counts) => counts.visible === 1 && counts.inFlight === 0,
      3000,
    );
    expect(await ledgerCount(wallet.id)).toBe(0);

    await unlock();
    await instance.process.exited;
    spawnInstance(queues);
    await drained(queues);

    expect(await ledgerCount(wallet.id)).toBe(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);
});

describe("ROLES", () => {
  test("consumer only: consumes, keeps health, has no API", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    await sendMessage(queues, wagerMessage(wallet));

    const instance = await startTestApp(db.url, {
      roles: ["consumer"],
      sqs: { queueName: queues.queueName, dlqName: queues.dlqName },
    });
    cleanups.push(() => instance.app.close());
    await drained(queues);

    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
    expect((await request(instance.url, "GET", "/health/live")).status).toBe(200);
    expect((await request(instance.url, "POST", "/wallets", {})).status).toBe(404);
  }, LONG);

  test.each([[["api"]], [["outbox", "pending"]]] as [("api" | "outbox" | "pending")[]][])(
    "%j does not consume",
    async (roles) => {
      const queues = await queuesFor();
      const wallet = await createWallet(url, "100.00");
      await sendMessage(queues, wagerMessage(wallet));

      const instance = await startTestApp(db.url, {
        roles,
        sqs: { queueName: queues.queueName, dlqName: queues.dlqName },
      });
      cleanups.push(() => instance.app.close());
      await Bun.sleep(1000);

      expect(await queueCounts(queues)).toEqual({ visible: 1, inFlight: 0 });
      expect(() => instance.app.get(WagerConsumer, { strict: false })).toThrow();
    },
    LONG,
  );
});

describe("bun run sqs:send", () => {
  test("publishes a message the consumer applies, grouped by wallet and deduplicated by messageId", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(url, "100.00");
    const run = () =>
      Bun.spawn(
        ["bun", "run", "sqs:send", "--wallet", wallet.id, "--player", wallet.playerId, "--amount", "10.00", "--message-id", messageId],
        { env: { ...process.env, SQS_QUEUE_NAME: queues.queueName }, stdout: "pipe", stderr: "pipe" },
      );
    const messageId = `script-${randomUUIDv7()}`;

    const first = run();
    expect(await first.exited).toBe(0);
    expect(JSON.parse(await new Response(first.stdout).text())).toMatchObject({ messageId, messageGroupId: wallet.id });
    expect(await run().exited).toBe(0);

    startConsumer(queues);
    await drained(queues);

    expect(await wagers(wallet.id)).toHaveLength(1);
    await expectBalanceMatchesLedger(sql, wallet.id, "90.00");
  }, LONG);
});

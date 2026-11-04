import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL, sleep } from "bun";
import { SIMULATED_CRASH_EXIT_CODE } from "../../src/infrastructure/test-hooks";
import { createTestDatabase, type TestDatabase } from "../integration/db/support";
import { type AppProcess, spawnApp, waitUntilLive } from "../support/processes";
import {
  createTestQueues,
  eventually,
  type PublishedEvent,
  queueCounts,
  readDlq,
  sendMessage,
  takeEvents,
  type TestQueues,
  wagerMessage,
} from "../support/sqs";
import {
  createWallet,
  expectBalanceMatchesLedger,
  type HttpResult,
  request,
  startTestApp,
  submit,
  type TestApp,
  type TestWallet,
  wagerBody,
} from "../support/test-app";

const LONG = { timeout: 120_000 };
const ONE = { amount: "1.00", currency: "BRL" };

let db: TestDatabase;
let sql: SQL;
/** An in-process instance with the API only, used to set up wallets. It runs no worker. */
let setup: TestApp;

const cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
  setup = await startTestApp(db.url);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  await setup.app.close();
  await db.drop();
});

async function queuesFor(): Promise<TestQueues> {
  const queues = await createTestQueues();
  cleanups.push(() => queues.drop());
  return queues;
}

async function instance(queues: TestQueues, env: Record<string, string> = {}): Promise<AppProcess> {
  const app = await spawnApp(db.url, queues, env);
  cleanups.push(() => app.stop("SIGKILL"));
  await waitUntilLive(app);
  return app;
}

/** Retries what a provider would retry: 503s and connections cut by a dying instance. Same key every time. */
async function submitUntilAnswered(
  urls: () => string[],
  body: Record<string, unknown>,
  key = `${body.providerId}:${body.externalTransactionId}`,
): Promise<HttpResult> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const live = urls();
    try {
      const result = await submit(live[attempt % live.length] as string, body, key);
      if (result.status !== 503) return result;
    } catch {
      // The instance went away: the next attempt goes elsewhere.
    }
    await sleep(50);
  }
  throw new Error("No instance answered");
}

const queueDrained = (queues: TestQueues) =>
  eventually(
    () => queueCounts(queues),
    (counts) => counts.visible === 0 && counts.inFlight === 0,
    60_000,
  );

const noPendingReferences = () =>
  eventually(
    async () => (await sql`SELECT count(*)::int AS count FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`)[0].count,
    (count) => count === 0,
    60_000,
  );

const outboxDrained = () =>
  eventually(
    async () => (await sql`SELECT count(*)::int AS count FROM outbox_messages WHERE published_at IS NULL`)[0].count,
    (count) => count === 0,
    60_000,
  );

/** The final invariant, read through both the ledger and the public reconciliation endpoint. */
async function expectConsistent(url: string, expected: Map<string, string>): Promise<void> {
  for (const [walletId, balance] of expected) {
    await expectBalanceMatchesLedger(sql, walletId, balance);
    const report = await request(url, "POST", `/wallets/${walletId}/reconciliation`);
    expect(report.body).toMatchObject({ walletId, consistent: true, difference: { amount: "0.00" } });
  }
}

const debitsOf = async (walletId: string): Promise<number> =>
  (await sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`)[0].count;

const logged = (app: AppProcess, message: string) => app.logs().filter((line) => line.message === message);

const allEventIds = async (): Promise<string[]> =>
  (await sql`SELECT id FROM outbox_messages`).map((row: { id: string }) => row.id);

/** Takes events off the queue until every expected id showed up. */
async function collectEvents(queues: TestQueues, expectedIds: string[]): Promise<PublishedEvent[]> {
  const collected: PublishedEvent[] = [];
  const missing = () => {
    const seen = new Set(collected.map((event) => event.eventId));
    return expectedIds.filter((id) => !seen.has(id));
  };
  await eventually(
    async () => {
      collected.push(...(await takeEvents(queues)));
      return missing().length;
    },
    (count) => count === 0,
    60_000,
  );
  return collected;
}

/** Seen events are forgotten between tests, so each one only looks at its own wallets. */
async function markEverythingPublished() {
  await sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
}

describe("a. three full instances on the same wallets, over HTTP and SQS", () => {
  test("no debit or credit is duplicated, and the invariants hold", async () => {
    await markEverythingPublished();
    const queues = await queuesFor();
    const apps = await Promise.all([instance(queues), instance(queues), instance(queues)]);
    const urls = () => apps.map((app) => app.url);

    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(setup.url, "1000.00")));
    const betsPerWallet = 30;
    const work: Promise<unknown>[] = [];

    for (const wallet of wallets) {
      for (let i = 0; i < betsPerWallet; i++) {
        const message = wagerMessage(wallet, { dataOverrides: { money: ONE } });
        const { idempotencyKey: key, ...body } = message.data;
        if (i % 3 === 0) {
          // The same operation on two instances at once.
          work.push(submitUntilAnswered(urls, body, key), submitUntilAnswered(() => [...urls()].reverse(), body, key));
        } else if (i % 3 === 1) {
          // The same message delivered twice.
          work.push(sendMessage(queues, message), sendMessage(queues, message));
        } else {
          // The same operation arriving through both entries.
          work.push(sendMessage(queues, message), submitUntilAnswered(urls, body, key));
        }
      }
    }
    await Promise.all(work);

    await queueDrained(queues);
    await noPendingReferences();
    await outboxDrained();

    expect(await readDlq(queues)).toHaveLength(0);
    for (const wallet of wallets) {
      expect(await debitsOf(wallet.id)).toBe(betsPerWallet);
      const [row] = await sql`
        SELECT count(*)::int AS count FROM wager_transactions
         WHERE wallet_id = ${wallet.id} AND kind = 'BET' AND status = 'PROCESSED'`;
      expect(row.count).toBe(betsPerWallet);
    }
    await expectConsistent(urls()[0] as string, new Map(wallets.map((wallet) => [wallet.id, "970.00"])));
  }, LONG);
});

describe("b. crash after the commit and before the ack", () => {
  test("the redelivery falls on the inbox of another process, with one effect", async () => {
    const queues = await queuesFor();
    const wallet = await createWallet(setup.url, "100.00");
    const message = wagerMessage(wallet);
    await sendMessage(queues, message);

    const crashing = await spawnApp(db.url, queues, {
      ROLES: "consumer",
      TEST_CRASH_AFTER_COMMIT: "1",
      SQS_VISIBILITY_TIMEOUT_S: "1",
    });
    cleanups.push(() => crashing.stop("SIGKILL"));

    expect(await crashing.process.exited).toBe(SIMULATED_CRASH_EXIT_CODE);
    expect(await debitsOf(wallet.id)).toBe(1);
    const left = await queueCounts(queues);
    expect(left.visible + left.inFlight).toBe(1);

    const next = await instance(queues, { ROLES: "consumer" });
    await queueDrained(queues);

    expect(logged(next, "Duplicate message ignored")).toHaveLength(1);
    expect(logged(next, "Message processed")).toHaveLength(0);
    expect(await debitsOf(wallet.id)).toBe(1);
    const inbox = await sql`SELECT 1 FROM inbox_messages WHERE message_id = ${message.messageId}`;
    expect(inbox).toHaveLength(1);
    await expectConsistent(setup.url, new Map([[wallet.id, "75.00"]]));
  }, LONG);
});

describe("c. two publishers on the same outbox", () => {
  test("every event is published, none by both, and each aggregate stays in order", async () => {
    await markEverythingPublished();
    const queues = await queuesFor();
    const [one, two] = await Promise.all([
      instance(queues, { ROLES: "outbox", OUTBOX_POLL_INTERVAL_MS: "10" }),
      instance(queues, { ROLES: "outbox", OUTBOX_POLL_INTERVAL_MS: "10" }),
    ]);
    const before = new Set(await allEventIds());

    // Seeded with both already running, so they contend instead of one finishing before the other boots.
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(setup.url, "1000.00")));
    await Promise.all(
      wallets.map(async (wallet) => {
        for (let i = 0; i < 15; i++) {
          expect((await submit(setup.url, wagerBody(wallet, { money: ONE }))).status).toBe(200);
        }
      }),
    );
    await outboxDrained();

    const expected = (await allEventIds()).filter((id) => !before.has(id));
    expect(expected.length).toBeGreaterThanOrEqual(6 * (1 + 15 * 2));
    const events = await collectEvents(queues, expected);

    const byOne = logged(one as AppProcess, "Outbox event published").map((line) => line.eventId);
    const byTwo = logged(two as AppProcess, "Outbox event published").map((line) => line.eventId);
    expect(byOne.length).toBeGreaterThan(0);
    expect(byTwo.length).toBeGreaterThan(0);
    expect(byOne.filter((id) => byTwo.includes(id))).toEqual([]);

    for (const event of events) expect(event.groupId).toBe(event.aggregateId);
    for (const wallet of wallets) {
      const versions = events
        .filter((event) => event.eventType === "WalletBalanceChanged" && event.aggregateId === wallet.id)
        .map((event) => event.data.walletVersion as number);
      expect(versions).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
      await expectBalanceMatchesLedger(sql, wallet.id, "985.00");
    }
  }, LONG);
});

describe("d. a publisher dies after publishing and before the commit", () => {
  test("the event is published again with the same eventId, and nothing is lost", async () => {
    await markEverythingPublished();
    const queues = await queuesFor();
    const wallet = await createWallet(setup.url, "100.00");
    await markEverythingPublished();
    expect((await submit(setup.url, wagerBody(wallet))).status).toBe(200);
    const expected = (await sql`SELECT id FROM outbox_messages WHERE published_at IS NULL`).map((row: { id: string }) => row.id);
    expect(expected).toHaveLength(2);

    const crashing = await spawnApp(db.url, queues, { ROLES: "outbox", TEST_CRASH_AFTER_PUBLISH: "1" });
    cleanups.push(() => crashing.stop("SIGKILL"));
    expect(await crashing.process.exited).toBe(SIMULATED_CRASH_EXIT_CODE);

    // On the broker, but the rollback left it unpublished in the outbox. The two events belong
    // to different aggregates, which are sent in parallel, so the second one may have made it too.
    const onBroker = await takeEvents(queues);
    expect(onBroker.length).toBeGreaterThanOrEqual(1);
    for (const event of onBroker) {
      expect(expected).toContain(event.eventId);
      const [row] = await sql`SELECT published_at FROM outbox_messages WHERE id = ${event.eventId}`;
      expect(row.published_at).toBeNull();
    }

    const next = await instance(queues, { ROLES: "outbox" });
    await outboxDrained();

    // Everything was published again, including what the dead publisher had already sent.
    const published = logged(next, "Outbox event published").map((line) => line.eventId);
    expect([...published].sort()).toEqual([...expected].sort());

    // The broker's own deduplication drops the copy inside its 5 minute window, keyed by this
    // same eventId. Past that window it would arrive, and consumers deduplicate by eventId.
    await sleep(300);
    const rest = await takeEvents(queues);
    expect(new Set([...onBroker, ...rest].map((event) => event.eventId))).toEqual(new Set(expected));
    expect(rest.filter((event) => onBroker.some((first) => first.eventId === event.eventId))).toEqual([]);
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  }, LONG);
});

describe("e. reversals arriving before their reference", () => {
  // An hour of backoff: only the wake-up from the processed reference can explain the speed.
  const shortcutOnly = { PENDING_BACKOFF_BASE_MS: "3600000", PENDING_BACKOFF_MAX_MS: "3600000" };

  type Channel = "http" | "sqs";

  async function deliver(channel: Channel, queues: TestQueues, url: string, wallet: TestWallet, data: Record<string, unknown>) {
    if (channel === "http") return submit(url, wagerBody(wallet, data));
    await sendMessage(queues, wagerMessage(wallet, { dataOverrides: data }));
    return undefined;
  }

  const statusOf = async (externalId: string) =>
    (await sql`SELECT * FROM wager_transactions WHERE external_transaction_id = ${externalId}`)[0];

  const untilStatus = (externalId: string, status: string) =>
    eventually(
      () => statusOf(externalId),
      (row) => row?.status === status,
      30_000,
    );

  test.each([
    ["REFUND", "http"],
    ["REFUND", "sqs"],
    ["ROLLBACK", "http"],
    ["ROLLBACK", "sqs"],
  ] as [string, Channel][])(
    "%s via %s waits as PENDING_REFERENCE, the BET arrives, and the worker applies it",
    async (kind, channel) => {
      const queues = await queuesFor();
      const app = await instance(queues, shortcutOnly);
      const wallet = await createWallet(setup.url, "100.00");
      const betId = `bet-${randomUUIDv7()}`;
      const reversalId = `reversal-${randomUUIDv7()}`;

      const early = await deliver(channel, queues, app.url, wallet, {
        kind,
        externalTransactionId: reversalId,
        referenceExternalTransactionId: betId,
      });
      if (early) {
        expect(early.status).toBe(202);
        expect(early.body.status).toBe("PENDING_REFERENCE");
      }
      const pending = await untilStatus(reversalId, "PENDING_REFERENCE");
      await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
      const announced = await sql`
        SELECT 1 FROM outbox_messages WHERE aggregate_id = ${pending.id} AND event_type = 'WagerTransactionPendingReference'`;
      expect(announced).toHaveLength(1);

      await deliver(channel, queues, app.url, wallet, { externalTransactionId: betId });

      const applied = await untilStatus(reversalId, "PROCESSED");
      const bet = await statusOf(betId);
      expect(bet.status).toBe("PROCESSED");
      expect(applied.reference_transaction_id).toBe(bet.id);
      expect(applied.next_attempt_at).toBeNull();
      await queueDrained(queues);
      await outboxDrained();
      const events = await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${pending.id} ORDER BY occurred_at, id`;
      expect(events.map((row: { event_type: string }) => row.event_type)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionProcessed",
      ]);
      await expectConsistent(app.url, new Map([[wallet.id, "100.00"]]));
    },
    LONG,
  );

  test("a ROLLBACK of a REFUND of a BET, all in reverse order: each one wakes the next", async () => {
    const queues = await queuesFor();
    const app = await instance(queues, shortcutOnly);
    const wallet = await createWallet(setup.url, "100.00");
    const betId = `bet-${randomUUIDv7()}`;
    const refundId = `refund-${randomUUIDv7()}`;
    const rollbackId = `rollback-${randomUUIDv7()}`;

    const rollback = await submit(
      app.url,
      wagerBody(wallet, { kind: "ROLLBACK", externalTransactionId: rollbackId, referenceExternalTransactionId: refundId }),
    );
    expect(rollback.status).toBe(202);
    const refund = await submit(
      app.url,
      wagerBody(wallet, { kind: "REFUND", externalTransactionId: refundId, referenceExternalTransactionId: betId }),
    );
    expect(refund.status).toBe(202);
    expect((await submit(app.url, wagerBody(wallet, { externalTransactionId: betId }))).status).toBe(200);

    await untilStatus(rollbackId, "PROCESSED");
    await expectConsistent(app.url, new Map([[wallet.id, "75.00"]]));
  }, LONG);
});

describe("f. a reference that never arrives", () => {
  test("after the attempts: REJECTED, and the event reaches the broker", async () => {
    await markEverythingPublished();
    const queues = await queuesFor();
    await instance(queues, { PENDING_BACKOFF_BASE_MS: "10", PENDING_BACKOFF_MAX_MS: "30" });
    const wallet = await createWallet(setup.url, "100.00");
    const message = wagerMessage(wallet, {
      dataOverrides: { kind: "REFUND", referenceExternalTransactionId: `never-${randomUUIDv7()}` },
    });
    await sendMessage(queues, message);

    const external = message.data.externalTransactionId as string;
    const row = await eventually(
      async () => (await sql`SELECT * FROM wager_transactions WHERE external_transaction_id = ${external}`)[0],
      (found) => found?.status === "REJECTED",
      30_000,
    );
    expect(row.failure_code).toBe("REFERENCE_NOT_FOUND");
    expect(row.attempts).toBe(9);
    expect(row.balance_after).toBe("100.00");
    expect(row.next_attempt_at).toBeNull();

    await outboxDrained();
    const ids = (await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${row.id}`).map((event: { id: string }) => event.id);
    const events = await collectEvents(queues, ids);
    const own = events.filter((event) => event.aggregateId === row.id).map((event) => event.eventType);
    expect(own).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  }, LONG);
});

describe("g. restart in the middle of the load", () => {
  test("killed and restarted instances end consistent, every wallet reconciled", async () => {
    await markEverythingPublished();
    const queues = await queuesFor();
    const env = { SQS_VISIBILITY_TIMEOUT_S: "2" };
    let apps: AppProcess[] = await Promise.all([instance(queues, env), instance(queues, env), instance(queues, env)]);
    const urls = () => apps.map((app) => app.url);

    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet(setup.url, "1000.00")));
    const expected = new Map(wallets.map((wallet) => [wallet.id, 1000]));
    const operations = 40;

    const load = wallets.map(async (wallet) => {
      for (let i = 0; i < operations; i++) {
        const betId = `bet-${randomUUIDv7()}`;
        const betBody = { money: ONE, externalTransactionId: betId };
        if (i % 4 === 0) {
          // A reversal ahead of its BET, across the restart: nets to zero.
          const reversal = wagerBody(wallet, { kind: "REFUND", money: ONE, referenceExternalTransactionId: betId });
          expect((await submitUntilAnswered(urls, reversal)).status).toBe(202);
          expect((await submitUntilAnswered(urls, wagerBody(wallet, betBody))).status).toBe(200);
        } else {
          expected.set(wallet.id, (expected.get(wallet.id) as number) - 1);
          if (i % 2 === 0) await sendMessage(queues, wagerMessage(wallet, { dataOverrides: betBody }));
          else expect((await submitUntilAnswered(urls, wagerBody(wallet, betBody))).status).toBe(200);
        }
        await sleep(25);
      }
    });

    await sleep(400);
    const [killed, stopped, kept] = apps as [AppProcess, AppProcess, AppProcess];
    apps = [kept];
    await Promise.all([killed.stop("SIGKILL"), stopped.stop("SIGTERM")]);
    await sleep(300);
    const replacements = await Promise.all([instance(queues, env), instance(queues, env)]);
    apps = [kept, ...replacements];

    await Promise.all(load);
    await queueDrained(queues);
    await noPendingReferences();
    await outboxDrained();

    expect(await readDlq(queues)).toHaveLength(0);
    await expectConsistent(
      kept.url,
      new Map([...expected].map(([walletId, balance]) => [walletId, `${balance}.00`])),
    );
    const everyWallet = await sql`SELECT id FROM wallets`;
    for (const { id } of everyWallet) {
      const report = await request(kept.url, "POST", `/wallets/${id}/reconciliation`);
      expect(report.body.consistent).toBe(true);
    }
  }, LONG);
});

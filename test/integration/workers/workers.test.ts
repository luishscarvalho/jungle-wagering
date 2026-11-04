import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { randomUUIDv7, type SQL, sleep } from "bun";
import { PublishOutbox } from "../../../src/application/outbox/publish-outbox";
import {
  type AppLogger,
  CLOCK,
  type EventPublisher,
  ID_GENERATOR,
  type IdGenerator,
  METRICS,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../../src/application/ports";
import { ProcessPendingReferences } from "../../../src/application/wager/process-pending-references";
import type { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { isTransientInfrastructureError } from "../../../src/infrastructure/transient-errors";
import { createSqsClient } from "../../support/sqs";
import {
  createWallet,
  expectBalanceMatchesLedger,
  metricValue,
  startTestApp,
  submit,
  type TestApp,
  type TestWallet,
  wagerBody,
} from "../../support/test-app";
import { createTestDatabase, type TestDatabase } from "../db/support";

let db: TestDatabase;
let sql: SQL;
let testApp: TestApp;
let url: string;
let unitOfWork: UnitOfWork;

const silent: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
  testApp = await startTestApp(db.url);
  url = testApp.url;
  unitOfWork = testApp.app.get(UNIT_OF_WORK);
});

afterAll(async () => {
  await testApp.app.close();
  await db.drop();
});

async function waitForLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if (row.waiting >= expected) return;
    await sleep(5);
  }
  throw new Error(`Fewer than ${expected} rounds reached the lock`);
}

describe("wagering-events.fifo in the compose stack", () => {
  test("is FIFO with content-based deduplication off", async () => {
    const client = createSqsClient();
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: "wagering-events.fifo" }));
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["FifoQueue", "ContentBasedDeduplication"] }),
    );
    client.destroy();

    expect(Attributes?.FifoQueue).toBe("true");
    expect(Attributes?.ContentBasedDeduplication).toBe("false");
  });
});

describe("outbox publisher", () => {
  /** Rows are global to the database, so each test starts with nothing left to publish. */
  async function clearOutbox() {
    await sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
  }

  function fakePublisher(fails: (message: OutboxMessage) => boolean = () => false) {
    const published: OutboxMessage[] = [];
    const publisher: EventPublisher = {
      publish: async (message) => {
        if (fails(message)) throw new Error("broker down");
        published.push(message);
      },
    };
    return { publisher, published };
  }

  function outboxWith(publisher: EventPublisher, backoff = { baseMs: 1000, maxMs: 60_000 }) {
    return new PublishOutbox(unitOfWork, publisher, testApp.app.get(CLOCK), silent, testApp.app.get(METRICS), backoff);
  }

  async function betsOn(wallet: TestWallet, count: number) {
    for (let i = 0; i < count; i++) {
      const result = await submit(url, wagerBody(wallet, { money: { amount: "1.00", currency: "BRL" } }));
      expect(result.status).toBe(200);
    }
  }

  const unpublished = (aggregateId: string) =>
    sql`SELECT id, attempts FROM outbox_messages
         WHERE aggregate_id = ${aggregateId} AND published_at IS NULL ORDER BY occurred_at, id`;

  test("publishes due messages in occurrence order and marks them", async () => {
    await clearOutbox();
    const wallet = await createWallet(url, "100.00");
    await betsOn(wallet, 3);
    const { publisher, published } = fakePublisher();

    expect(await outboxWith(publisher).runRound()).toBe(true);

    const versions = published
      .filter((message) => message.aggregateId === wallet.id && message.eventType === "WalletBalanceChanged")
      .map((message) => (message.payload.data as { walletVersion: number }).walletVersion);
    expect(versions).toEqual([1, 2, 3, 4]);
    expect(await unpublished(wallet.id)).toEqual([]);
    expect(await outboxWith(publisher).runRound()).toBe(false);
  });

  test("a failure holds back the rest of its aggregate only, and only the failed one is rescheduled", async () => {
    await clearOutbox();
    const failing = await createWallet(url, "100.00");
    const healthy = await createWallet(url, "100.00");
    await clearOutbox();
    await betsOn(failing, 3);
    await betsOn(healthy, 2);
    const [first] = await unpublished(failing.id);
    const { publisher, published } = fakePublisher((message) => message.id === first.id);

    await outboxWith(publisher).runRound();

    expect(published.filter((message) => message.aggregateId === failing.id)).toEqual([]);
    expect(published.filter((message) => message.aggregateId === healthy.id)).toHaveLength(2);
    expect((await unpublished(failing.id)).map((row: { attempts: number }) => row.attempts)).toEqual([1, 0, 0]);
  });

  test("the next round does not overtake a message waiting for its backoff", async () => {
    await clearOutbox();
    const wallet = await createWallet(url, "100.00");
    await clearOutbox();
    await betsOn(wallet, 2);
    const [first] = await unpublished(wallet.id);
    let down = true;
    const { publisher, published } = fakePublisher((message) => down && message.id === first.id);
    const outbox = outboxWith(publisher, { baseMs: 300, maxMs: 300 });

    await outbox.runRound();
    await outbox.runRound();
    expect(published.filter((message) => message.aggregateId === wallet.id)).toEqual([]);

    down = false;
    await sleep(350);
    await outbox.runRound();
    const versions = published
      .filter((message) => message.aggregateId === wallet.id)
      .map((message) => (message.payload.data as { walletVersion: number }).walletVersion);
    expect(versions).toEqual([2, 3]);
  });

  test("while one publisher holds an aggregate, another takes nothing from it", async () => {
    await clearOutbox();
    const wallet = await createWallet(url, "100.00");
    await clearOutbox();
    await betsOn(wallet, 3);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const slowStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slowPublished: string[] = [];
    const slow = outboxWith({
      publish: async (message) => {
        entered();
        await gate;
        slowPublished.push(message.id);
      },
    });
    const other = fakePublisher();

    const slowRound = slow.runRound();
    await slowStarted;
    await outboxWith(other.publisher).runRound();
    release();
    await slowRound;

    expect(other.published.filter((message) => message.aggregateId === wallet.id)).toEqual([]);
    expect(await unpublished(wallet.id)).toEqual([]);
  });
});

describe("pending reference worker", () => {
  const fast = { baseMs: 1, maxMs: 1 };
  const worker = (backoff = fast) =>
    new ProcessPendingReferences(
      unitOfWork,
      testApp.app.get(ID_GENERATOR),
      testApp.app.get(CLOCK),
      silent,
      testApp.app.get(METRICS),
      isTransientInfrastructureError,
      backoff,
    );
  /** Fails while applying the movement, inside the transaction, as a driver error would. */

  async function pendingRefund(wallet: TestWallet, reference = `missing-${randomUUIDv7()}`) {
    const body = wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: reference });
    const result = await submit(url, body);
    expect(result.status).toBe(202);
    return { id: result.body.transactionId as string, body, reference };
  }

  const rowOf = async (id: string) => (await sql`SELECT * FROM wager_transactions WHERE id = ${id}`)[0];
  const due = (id: string) => sql`UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ${id}`;
  const eventsOf = async (id: string) =>
    (await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${id} ORDER BY occurred_at, id`).map(
      (row: { event_type: string }) => row.event_type,
    );

  test("not due yet: untouched", async () => {
    const wallet = await createWallet(url);
    const { id } = await pendingRefund(wallet);

    await worker().runRound();

    expect((await rowOf(id)).attempts).toBe(0);
  });

  test("still missing: reschedules with backoff, counts the attempt, announces nothing new", async () => {
    const wallet = await createWallet(url);
    const { id } = await pendingRefund(wallet);
    await due(id);

    await worker({ baseMs: 60_000, maxMs: 60_000 }).runRound();

    const row = await rowOf(id);
    expect(row.status).toBe("PENDING_REFERENCE");
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(await eventsOf(id)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("the reference arrived: applies balance, ledger and events", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = wagerBody(wallet);
    const { id } = await pendingRefund(wallet, bet.externalTransactionId as string);
    expect((await submit(url, bet)).status).toBe(200);
    await due(id);

    await worker().runRound();

    const row = await rowOf(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.reference_transaction_id).toBeString();
    expect(row.next_attempt_at).toBeNull();
    expect(row.balance_after).toBe("100.00");
    expect(await eventsOf(id)).toEqual(["WagerTransactionPendingReference", "WagerTransactionProcessed"]);
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("attempts exhausted: REJECTED with the policy's code and the event, with no balance change", async () => {
    const wallet = await createWallet(url, "100.00");
    const { id } = await pendingRefund(wallet);
    await sql`UPDATE wager_transactions SET attempts = 9, next_attempt_at = now() WHERE id = ${id}`;

    await worker().runRound();

    const row = await rowOf(id);
    expect(row.status).toBe("REJECTED");
    expect(row.failure_code).toBe("REFERENCE_NOT_FOUND");
    expect(row.balance_after).toBe("100.00");
    expect(await eventsOf(id)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("a reference in another wallet is rejected on retry, with no reference id stored", async () => {
    const wallet = await createWallet(url, "100.00");
    const other = await createWallet(url, "100.00");
    const foreignBet = wagerBody(other);
    const { id } = await pendingRefund(wallet, foreignBet.externalTransactionId as string);
    expect((await submit(url, foreignBet)).status).toBe(200);
    await due(id);

    await worker().runRound();

    const row = await rowOf(id);
    expect(row.status).toBe("REJECTED");
    expect(row.failure_code).toBe("REFERENCE_MISMATCH");
    expect(row.reference_transaction_id).toBeNull();
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("a REFUND and a ROLLBACK waiting on one BET: one applies, the other is REFERENCE_ALREADY_REVERSED", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = wagerBody(wallet);
    const external = bet.externalTransactionId as string;
    const refund = await pendingRefund(wallet, external);
    const rollback = await submit(url, wagerBody(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: external }));
    expect((await submit(url, bet)).status).toBe(200);
    await due(refund.id);
    await due(rollback.body.transactionId);

    await worker().runRound();

    const statuses = [await rowOf(refund.id), await rowOf(rollback.body.transactionId)];
    expect(statuses.map((row) => row.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(statuses.find((row) => row.status === "REJECTED").failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("workers that selected the same row at once count one attempt: the status is revalidated under lock", async () => {
    const wallet = await createWallet(url);
    const { id } = await pendingRefund(wallet);
    await due(id);
    const rounds = 4;
    const slow = { baseMs: 60_000, maxMs: 60_000 };

    let results: Promise<boolean[]> | undefined;
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      results = Promise.all(Array.from({ length: rounds }, () => worker(slow).runRound()));
      await waitForLockWaiters(rounds);
    });
    await results;

    expect((await rowOf(id)).attempts).toBe(1);
  });

  test("a wallet held past lock_timeout costs no attempt and the row stays due", async () => {
    const wallet = await createWallet(url);
    const { id } = await pendingRefund(wallet);
    await due(id);

    const progressed = await sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      return worker().runRound();
    });

    expect(progressed).toBe(false);
    const row = await rowOf(id);
    expect(row.attempts).toBe(0);
    expect(row.status).toBe("PENDING_REFERENCE");
  }, 15_000);
});

describe("pending reference worker when the attempt errors", () => {
  const worker = (ids: IdGenerator) =>
    new ProcessPendingReferences(
      unitOfWork,
      ids,
      testApp.app.get(CLOCK),
      silent,
      testApp.app.get(METRICS),
      isTransientInfrastructureError,
      { baseMs: 1, maxMs: 1 },
    );
  const idsFailingWith = (error: Error): IdGenerator => ({
    next: () => {
      throw error;
    },
  });
  const rowOf = async (id: string) => (await sql`SELECT * FROM wager_transactions WHERE id = ${id}`)[0];

  /** A refund whose BET already processed, so the worker reaches the balance movement. */
  async function refundReadyToApply() {
    // Rows are global to the database, so what earlier tests left waiting stays out of this round.
    await sql`UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE status = 'PENDING_REFERENCE'`;
    const wallet = await createWallet(url, "100.00");
    const bet = wagerBody(wallet);
    const body = wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId });
    const refund = await submit(url, body);
    expect(refund.status).toBe(202);
    expect((await submit(url, bet)).status).toBe(200);
    await sql`UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ${refund.body.transactionId}`;
    return { wallet, body, id: refund.body.transactionId as string, external: refund.body };
  }

  test("a non-transient error ends as FAILED with PROCESSING_FAILED, with no balance change, and is counted", async () => {
    const { wallet, id } = await refundReadyToApply();
    const failedBefore = await metricValue(url, "wagering_transactions_total", { status: "FAILED", kind: "REFUND" });

    expect(await worker(idsFailingWith(new Error("poison"))).runRound()).toBe(true);

    const row = await rowOf(id);
    expect(row.status).toBe("FAILED");
    expect(row.failure_code).toBe("PROCESSING_FAILED");
    expect(row.next_attempt_at).toBeNull();
    expect(row.attempts).toBe(0);
    expect(await metricValue(url, "wagering_transactions_total", { status: "FAILED", kind: "REFUND" })).toBe(
      failedBefore + 1,
    );
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("a FAILED transaction is not picked up again, and a replay answers with what is stored", async () => {
    const { id, body } = await refundReadyToApply();
    await worker(idsFailingWith(new Error("poison"))).runRound();

    await worker(testApp.app.get(ID_GENERATOR)).runRound();

    expect((await rowOf(id)).status).toBe("FAILED");
    const replay = await submit(url, body);
    expect(replay.status).toBe(500);
    expect(replay.body).toEqual({
      transactionId: id,
      status: "FAILED",
      balance: null,
      failureCode: "PROCESSING_FAILED",
      idempotentReplay: true,
    });
  });

  test("a FAILED reference wakes whoever waits for it, who then rejects as REFERENCE_NOT_PROCESSED", async () => {
    const { wallet, id, external } = await refundReadyToApply();
    const [{ external_transaction_id: refundExternal, round_id: round }] =
      await sql`SELECT external_transaction_id, round_id FROM wager_transactions WHERE id = ${id}`;
    const rollback = await submit(
      url,
      wagerBody(wallet, { kind: "ROLLBACK", roundId: round, referenceExternalTransactionId: refundExternal }),
    );
    expect(rollback.status).toBe(202);
    expect(external.status).toBe("PENDING_REFERENCE");
    await sql`UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE id = ${rollback.body.transactionId}`;

    await sql`UPDATE wager_transactions SET next_attempt_at = now() WHERE id = ${id}`;
    await worker(idsFailingWith(new Error("poison"))).runRound();
    const [{ due }] = await sql`SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE id = ${rollback.body.transactionId}`;
    expect(due).toBe(true);

    await worker(testApp.app.get(ID_GENERATOR)).runRound();
    const row = await rowOf(rollback.body.transactionId);
    expect(row.status).toBe("REJECTED");
    expect(row.failure_code).toBe("REFERENCE_NOT_PROCESSED");
  });

  test("a transient error spends no attempt, stays due and counts as a retry", async () => {
    const { wallet, id } = await refundReadyToApply();
    const before = await metricValue(url, "wagering_retries_total", { source: "pending" });
    const transient = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

    expect(await worker(idsFailingWith(transient)).runRound()).toBe(false);

    const row = await rowOf(id);
    expect(row.status).toBe("PENDING_REFERENCE");
    expect(row.attempts).toBe(0);
    expect(row.failure_code).toBeNull();
    expect(await metricValue(url, "wagering_retries_total", { source: "pending" })).toBe(before + 1);

    await worker(testApp.app.get(ID_GENERATOR)).runRound();
    expect((await rowOf(id)).status).toBe("PROCESSED");
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });
});

describe("waking whoever waits for a settled transaction", () => {
  const farFuture = async (id: string) => {
    await sql`UPDATE wager_transactions SET next_attempt_at = now() + interval '1 hour' WHERE id = ${id}`;
  };
  const isDue = async (id: string) => {
    const [row] = await sql`SELECT next_attempt_at <= now() AS due FROM wager_transactions WHERE id = ${id}`;
    return row.due as boolean;
  };

  async function refundWaitingFor(wallet: TestWallet, reference: string, overrides: Record<string, unknown> = {}) {
    const result = await submit(
      url,
      wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: reference, ...overrides }),
    );
    expect(result.status).toBe(202);
    await farFuture(result.body.transactionId);
    return result.body.transactionId as string;
  }

  test("wakes those in the same wallet and provider, in the transaction that processed it", async () => {
    const wallet = await createWallet(url);
    const bet = wagerBody(wallet);
    const waiting = await refundWaitingFor(wallet, bet.externalTransactionId as string);
    expect(await isDue(waiting)).toBe(false);

    await submit(url, bet);

    expect(await isDue(waiting)).toBe(true);
  });

  test("leaves another provider, another external id and another wallet to their backoff", async () => {
    const wallet = await createWallet(url);
    const other = await createWallet(url);
    const bet = wagerBody(wallet);
    const external = bet.externalTransactionId as string;
    const otherProvider = await refundWaitingFor(wallet, external, { providerId: "provider-b" });
    const otherExternal = await refundWaitingFor(wallet, `other-${randomUUIDv7()}`);
    const otherWallet = await refundWaitingFor(other, external);

    await submit(url, bet);

    expect(await isDue(otherProvider)).toBe(false);
    expect(await isDue(otherExternal)).toBe(false);
    expect(await isDue(otherWallet)).toBe(false);
  });

  test("a rejected transaction wakes those in the same wallet and provider too", async () => {
    const wallet = await createWallet(url, "1.00");
    const other = await createWallet(url, "1.00");
    const bet = wagerBody(wallet);
    const external = bet.externalTransactionId as string;
    const waiting = await refundWaitingFor(wallet, external);
    const otherProvider = await refundWaitingFor(wallet, external, { providerId: "provider-b" });
    const otherWallet = await refundWaitingFor(other, external);

    expect((await submit(url, bet)).status).toBe(422);

    expect(await isDue(waiting)).toBe(true);
    expect(await isDue(otherProvider)).toBe(false);
    expect(await isDue(otherWallet)).toBe(false);
  });

  test("the woken transaction then rejects as REFERENCE_NOT_PROCESSED, with no wait", async () => {
    const wallet = await createWallet(url, "1.00");
    const bet = wagerBody(wallet);
    const waiting = await refundWaitingFor(wallet, bet.externalTransactionId as string);
    expect((await submit(url, bet)).status).toBe(422);

    const worker = new ProcessPendingReferences(
      unitOfWork,
      testApp.app.get(ID_GENERATOR),
      testApp.app.get(CLOCK),
      silent,
      testApp.app.get(METRICS),
      isTransientInfrastructureError,
    );
    await worker.runRound();

    const [row] = await sql`SELECT status, failure_code FROM wager_transactions WHERE id = ${waiting}`;
    expect(row).toEqual({ status: "REJECTED", failure_code: "REFERENCE_NOT_PROCESSED" });
    await expectBalanceMatchesLedger(sql, wallet.id, "1.00");
  });
});

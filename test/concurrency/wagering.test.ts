import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL, sleep } from "bun";
import {
  CLOCK,
  ID_GENERATOR,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../src/application/ports";
import { ProcessWagerTransaction } from "../../src/application/wager/process-wager-transaction";
import { createTestDatabase, type TestDatabase } from "../integration/db/support";
import {
  createWallet,
  expectBalanceMatchesLedger,
  type HttpResult,
  request,
  startTestApp,
  submit,
  type TestApp,
  wagerBody,
} from "../support/test-app";

const TIMEOUT_MS = 30_000;
const INSTANCES = 3;

let db: TestDatabase;
let sql: SQL;
let apps: TestApp[];

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
  // Separate Nest instances with separate connection pools, all on one database.
  apps = await Promise.all(Array.from({ length: INSTANCES }, () => startTestApp(db.url)));
});

afterAll(async () => {
  await Promise.all(apps.map(({ app }) => app.close()));
  await db.drop();
});

/** Spreads requests over the instances, so they contend on the database and not inside one process. */
function urlFor(index: number): string {
  return (apps[index % INSTANCES] as TestApp).url;
}

const money = (amount: string) => ({ amount, currency: "BRL" });

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
  throw new Error(`Fewer than ${expected} requests reached the database lock`);
}

/**
 * Forces the overlap instead of hoping for it: holds the wallet row, starts the
 * requests, and releases only once all of them are blocked in Postgres. Whatever
 * they read before blocking was read at the same time, so a missing lock in the
 * code under test shows up every run, not by luck of timing.
 */
async function raceOnWallet<T>(walletId: string, waiters: number, start: () => Promise<T>[]): Promise<T[]> {
  let results: Promise<T[]> | undefined;
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    results = Promise.all(start());
    await waitForLockWaiters(waiters);
  });
  return results as Promise<T[]>;
}

async function debitsOf(walletId: string) {
  return sql`SELECT * FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
}

describe("two bets competing for the same balance", () => {
  test(
    "100.00 and two simultaneous 80.00 bets: one PROCESSED, one REJECTED, 20.00 left, one DEBIT",
    async () => {
      const wallet = await createWallet(urlFor(0), "100.00");

      const results = await raceOnWallet(wallet.id, 2, () =>
        [0, 1].map((index) => submit(urlFor(index), wagerBody(wallet, { money: money("80.00") }))),
      );

      const statuses = results.map((result) => result.status).sort();
      expect(statuses).toEqual([200, 422]);
      const winner = results.find((result) => result.status === 200) as HttpResult;
      const loser = results.find((result) => result.status === 422) as HttpResult;
      expect(winner.body).toMatchObject({ status: "PROCESSED", balance: money("20.00") });
      expect(loser.body).toMatchObject({
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: money("20.00"),
      });

      const debits = await debitsOf(wallet.id);
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({ transaction_id: winner.body.transactionId, balance_after: "20.00" });

      const current = await request(urlFor(0), "GET", `/wallets/${wallet.id}`);
      expect(current.body).toMatchObject({ balance: money("20.00"), version: 2 });
      await expectBalanceMatchesLedger(sql, wallet.id, "20.00");
    },
    TIMEOUT_MS,
  );

  test(
    "30 bets at once on one wallet: only what the balance pays for goes through",
    async () => {
      const wallet = await createWallet(urlFor(0), "100.00");

      const results = await Promise.all(
        Array.from({ length: 30 }, (_, index) => submit(urlFor(index), wagerBody(wallet, { money: money("7.00") }))),
      );

      // 100.00 pays for exactly 14 bets of 7.00, whatever the order.
      expect(results.filter((result) => result.status === 200)).toHaveLength(14);
      expect(results.filter((result) => result.status === 422)).toHaveLength(16);
      expect(await debitsOf(wallet.id)).toHaveLength(14);
      await expectBalanceMatchesLedger(sql, wallet.id, "2.00");
    },
    TIMEOUT_MS,
  );
});

describe("the same bet sent 50 times in parallel", () => {
  test(
    "one debit and 49 replays, all with the same result",
    async () => {
      const wallet = await createWallet(urlFor(0), "100.00");
      const body = wagerBody(wallet);
      const key = `key-${randomUUIDv7()}`;

      const results = await Promise.all(Array.from({ length: 50 }, (_, index) => submit(urlFor(index), body, key)));

      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(results.filter((result) => result.body.idempotentReplay === false)).toHaveLength(1);
      expect(results.filter((result) => result.body.idempotentReplay === true)).toHaveLength(49);
      expect(new Set(results.map((result) => result.body.transactionId)).size).toBe(1);
      expect(results.every((result) => result.body.balance.amount === "75.00")).toBe(true);

      expect(await debitsOf(wallet.id)).toHaveLength(1);
      expect(await sql`SELECT id FROM wager_transactions WHERE idempotency_key = ${key}`).toHaveLength(1);
      await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
    },
    TIMEOUT_MS,
  );
});

describe("the idempotency lookup happens under the lock", () => {
  test(
    "a duplicate waiting for the lock sees the committed row, with no need for the safety net",
    async () => {
      const wallet = await createWallet(urlFor(0), "100.00");
      const body = wagerBody(wallet);
      const key = `key-${randomUUIDv7()}`;

      const { app } = apps[0] as TestApp;
      const real = app.get<UnitOfWork>(UNIT_OF_WORK);
      let transactions = 0;
      const counting: UnitOfWork = {
        reader: () => real.reader(),
        transaction: (work) => {
          transactions += 1;
          return real.transaction(work);
        },
      };
      const useCase = new ProcessWagerTransaction(counting, app.get(ID_GENERATOR), app.get(CLOCK));

      const results = await raceOnWallet(wallet.id, 2, () =>
        [1, 2].map(() => useCase.execute({ idempotencyKey: key, payload: body })),
      );

      expect(results.filter((result) => result.type === "result" && result.view.idempotentReplay)).toHaveLength(1);
      // The safety net would open a third transaction.
      expect(transactions).toBe(2);
      await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
    },
    TIMEOUT_MS,
  );
});

describe("10 distinct wallets in parallel", () => {
  test(
    "do not interfere with each other",
    async () => {
      const wallets = await Promise.all(Array.from({ length: 10 }, (_, index) => createWallet(urlFor(index), "100.00")));

      const results = await Promise.all(
        wallets.flatMap((wallet, walletIndex) =>
          Array.from({ length: 5 }, (_, betIndex) =>
            submit(urlFor(walletIndex + betIndex), wagerBody(wallet, { money: money("10.00") })),
          ),
        ),
      );

      expect(results.every((result) => result.status === 200)).toBe(true);
      for (const wallet of wallets) {
        expect(await debitsOf(wallet.id)).toHaveLength(5);
        const current = await request(urlFor(0), "GET", `/wallets/${wallet.id}`);
        expect(current.body).toMatchObject({ balance: money("50.00"), version: 6 });
        await expectBalanceMatchesLedger(sql, wallet.id, "50.00");
      }
    },
    TIMEOUT_MS,
  );
});

describe("races the wallet lock does not cover", () => {
  test(
    "the same key on two wallets in parallel: one wins, the other gets a 409",
    async () => {
      const [walletA, walletB] = await Promise.all([createWallet(urlFor(0)), createWallet(urlFor(1))]);
      const key = `key-${randomUUIDv7()}`;

      const results = await Promise.all([
        submit(urlFor(0), wagerBody(walletA), key),
        submit(urlFor(1), wagerBody(walletB), key),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(results.find((result) => result.status === 409)?.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
      expect(await sql`SELECT id FROM wager_transactions WHERE idempotency_key = ${key}`).toHaveLength(1);

      const debits = (await debitsOf(walletA.id)).length + (await debitsOf(walletB.id)).length;
      expect(debits).toBe(1);
      await expectBalanceMatchesLedger(sql, walletA.id);
      await expectBalanceMatchesLedger(sql, walletB.id);
    },
    TIMEOUT_MS,
  );

  test(
    "the same wallet created 20 times in parallel: one 201 and 19 409, with one OPENING",
    async () => {
      const playerId = randomUUIDv7();
      const body = { playerId, initialBalance: money("100.00") };

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) => request(urlFor(index), "POST", "/wallets", body)),
      );

      expect(results.filter((result) => result.status === 201)).toHaveLength(1);
      const conflicts = results.filter((result) => result.status === 409);
      expect(conflicts).toHaveLength(19);
      expect(conflicts.every((result) => result.body.failureCode === "WALLET_ALREADY_EXISTS")).toBe(true);

      expect(await sql`SELECT id FROM wager_transactions WHERE player_id = ${playerId}`).toHaveLength(1);
      const created = results.find((result) => result.status === 201) as HttpResult;
      await expectBalanceMatchesLedger(sql, created.body.id, "100.00");
    },
    TIMEOUT_MS,
  );
});

describe("a connection lost in the middle of a request", () => {
  test(
    "answers 503, leaves no effect, and the retry with the same key applies once",
    async () => {
      const wallet = await createWallet(urlFor(0), "100.00");
      const body = wagerBody(wallet);
      const key = `key-${randomUUIDv7()}`;

      let pending: Promise<HttpResult> | undefined;
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
        pending = submit(urlFor(0), body, key);
        await waitForLockWaiters(1);
        await sql`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
      });

      const interrupted = await (pending as Promise<HttpResult>);
      expect(interrupted.status).toBe(503);
      expect(interrupted.body.failureCode).toBe("INFRASTRUCTURE_UNAVAILABLE");
      expect(await sql`SELECT id FROM wager_transactions WHERE idempotency_key = ${key}`).toHaveLength(0);
      await expectBalanceMatchesLedger(sql, wallet.id, "100.00");

      const retried = await submit(urlFor(0), body, key);
      expect(retried.status).toBe(200);
      expect(retried.body.idempotentReplay).toBe(false);
      await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
    },
    TIMEOUT_MS,
  );
});

describe("reversals in parallel", () => {
  test(
    "10 simultaneous refunds of one bet: one credit",
    async () => {
      const wallet = await createWallet(urlFor(0), "100.00");
      const bet = wagerBody(wallet);
      expect((await submit(urlFor(0), bet)).status).toBe(200);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          submit(
            urlFor(index),
            wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId }),
          ),
        ),
      );

      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      const rejected = results.filter((result) => result.status === 422);
      expect(rejected).toHaveLength(9);
      expect(rejected.every((result) => result.body.failureCode === "REFERENCE_ALREADY_REVERSED")).toBe(true);
      await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
    },
    TIMEOUT_MS,
  );
});

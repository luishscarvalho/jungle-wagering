import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL } from "bun";
import { ReconcileWallet } from "../../../src/application/wallet/reconcile-wallet";
import {
  CLOCK,
  ID_GENERATOR,
  type Repositories,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../../src/application/ports";
import { type ProcessWagerResult, ProcessWagerTransaction } from "../../../src/application/wager/process-wager-transaction";
import { PostgresHealthCheck } from "../../../src/infrastructure/http/health/health.checks";
import {
  createWallet,
  expectBalanceMatchesLedger,
  startTestApp,
  type TestApp,
  wagerBody,
} from "../../support/test-app";
import { createTestDatabase, type TestDatabase } from "../db/support";

let db: TestDatabase;
let testApp: TestApp;
let url: string;
let sql: SQL;
let realUnitOfWork: UnitOfWork;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
  testApp = await startTestApp(db.url);
  url = testApp.url;
  realUnitOfWork = testApp.app.get(UNIT_OF_WORK);
});

afterAll(async () => {
  await testApp.app.close();
  await db.drop();
});

/** The use case against the real database, with one repository call changed in the first transaction. */
function useCaseWith(override: (repositories: Repositories) => Partial<Repositories>): ProcessWagerTransaction {
  let calls = 0;
  const unitOfWork: UnitOfWork = {
    reader: () => realUnitOfWork.reader(),
    transaction: (work) =>
      realUnitOfWork.transaction((repositories) =>
        work(calls++ === 0 ? { ...repositories, ...override(repositories) } : repositories),
      ),
  };
  return new ProcessWagerTransaction(unitOfWork, testApp.app.get(ID_GENERATOR), testApp.app.get(CLOCK));
}

const useCase = () => testApp.app.get(ProcessWagerTransaction);

async function counts(walletId: string) {
  const [row] = await sql`
    SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS transactions,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
           (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${walletId}) AS events,
           (SELECT version FROM wallets WHERE id = ${walletId}) AS version
  `;
  return row;
}

function view(result: ProcessWagerResult) {
  if (result.type !== "result") throw new Error(`Expected a result, got ${result.type}`);
  return result.view;
}

describe("atomicity", () => {
  const before = { transactions: 1, entries: 1, events: 1, version: 1 };

  test.each([
    ["ledger", () => ({ ledger: { insert: failing } })],
    ["wallet update", (r: Repositories) => ({ wallets: { ...walletsOf(r), update: failing } })],
    ["outbox", () => ({ outbox: { insert: failing } })],
  ] as [string, (r: Repositories) => Partial<Repositories>][])(
    "a failure writing the %s rolls everything back",
    async (_label, override) => {
      const wallet = await createWallet(url, "100.00");
      expect(await counts(wallet.id)).toEqual(before);

      const body = wagerBody(wallet);
      const failingUseCase = useCaseWith(override);
      await expect(failingUseCase.execute({ idempotencyKey: `k-${randomUUIDv7()}`, payload: body })).rejects.toThrow(
        "boom",
      );

      expect(await counts(wallet.id)).toEqual(before);
      await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
    },
  );

  const failing = async () => {
    throw new Error("boom");
  };

  function walletsOf(repositories: Repositories) {
    const { wallets } = repositories;
    return {
      findById: (id: string) => wallets.findById(id),
      findByIdForUpdate: (id: string) => wallets.findByIdForUpdate(id),
      insert: (wallet: Parameters<typeof wallets.insert>[0]) => wallets.insert(wallet),
      update: (wallet: Parameters<typeof wallets.update>[0]) => wallets.update(wallet),
    };
  }
});

describe("safety net for the idempotency unique constraint", () => {
  // Simulates losing the race: the lookup under lock misses the row, so the insert hits the constraint.
  const blindLookup = (repositories: Repositories) => ({
    transactions: Object.assign(Object.create(repositories.transactions), {
      findByIdempotencyKey: async () => undefined,
    }),
  });

  test("the same payload is answered as a replay", async () => {
    const wallet = await createWallet(url, "100.00");
    const key = `k-${randomUUIDv7()}`;
    const body = wagerBody(wallet);
    const first = view(await useCase().execute({ idempotencyKey: key, payload: body }));

    const second = view(await useCaseWith(blindLookup).execute({ idempotencyKey: key, payload: body }));

    expect(second).toEqual({ ...first, idempotentReplay: true });
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("a different payload is answered as a conflict", async () => {
    const wallet = await createWallet(url, "100.00");
    const key = `k-${randomUUIDv7()}`;
    await useCase().execute({ idempotencyKey: key, payload: wagerBody(wallet) });

    const second = await useCaseWith(blindLookup).execute({ idempotencyKey: key, payload: wagerBody(wallet) });

    expect(second).toMatchObject({ type: "refused", failureCode: "IDEMPOTENCY_CONFLICT" });
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });
});

describe("inbox", () => {
  const inbox = () => ({ consumerName: "wager-consumer", messageId: `m-${randomUUIDv7()}`, payloadHash: "raw-hash" });

  async function inboxRow(messageId: string) {
    const [row] = await sql`SELECT * FROM inbox_messages WHERE message_id = ${messageId}`;
    return row;
  }

  test("records the message as processed along with the outcome", async () => {
    const wallet = await createWallet(url, "100.00");
    const message = inbox();

    view(await useCase().execute({ idempotencyKey: `k-${randomUUIDv7()}`, payload: wagerBody(wallet), inbox: message }));

    const row = await inboxRow(message.messageId);
    expect(row.payload_hash).toBe("raw-hash");
    expect(row.processed_at).toBeInstanceOf(Date);
  });

  test("a redelivered message does nothing, even under a different key", async () => {
    const wallet = await createWallet(url, "100.00");
    const message = inbox();
    await useCase().execute({ idempotencyKey: `k-${randomUUIDv7()}`, payload: wagerBody(wallet), inbox: message });

    const again = await useCase().execute({
      idempotencyKey: `k-${randomUUIDv7()}`,
      payload: wagerBody(wallet),
      inbox: message,
    });

    expect(again).toEqual({ type: "duplicate-message" });
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("a refusal under lock is recorded, with no transaction", async () => {
    const wallet = await createWallet(url);
    const message = inbox();
    const missingWallet = randomUUIDv7();

    const result = await useCase().execute({
      idempotencyKey: `k-${randomUUIDv7()}`,
      payload: wagerBody(wallet, { walletId: missingWallet }),
      inbox: message,
    });

    expect(result).toMatchObject({ type: "refused", failureCode: "WALLET_NOT_FOUND" });
    expect((await inboxRow(message.messageId)).processed_at).toBeInstanceOf(Date);
    expect(await sql`SELECT id FROM wager_transactions WHERE wallet_id = ${missingWallet}`).toHaveLength(0);
  });

  test("an invalid payload is recorded too", async () => {
    const message = inbox();
    const result = await useCase().execute({ idempotencyKey: "k", payload: { kind: "JACKPOT" }, inbox: message });

    expect(result).toMatchObject({ type: "refused", failureCode: "INVALID_PAYLOAD" });
    expect(await inboxRow(message.messageId)).toBeDefined();
  });

  test("a rollback also undoes the inbox row, so the message can be retried", async () => {
    const wallet = await createWallet(url);
    const message = inbox();
    const failing = useCaseWith(() => ({
      outbox: {
        insert: async () => {
          throw new Error("boom");
        },
      },
    }));

    await expect(
      failing.execute({ idempotencyKey: `k-${randomUUIDv7()}`, payload: wagerBody(wallet), inbox: message }),
    ).rejects.toThrow("boom");

    expect(await inboxRow(message.messageId)).toBeUndefined();
  });

  test("the same message for another consumer is not a duplicate", async () => {
    const wallet = await createWallet(url, "100.00");
    const message = inbox();
    await useCase().execute({ idempotencyKey: `k-${randomUUIDv7()}`, payload: wagerBody(wallet), inbox: message });

    const other = await useCase().execute({
      idempotencyKey: `k-${randomUUIDv7()}`,
      payload: wagerBody(wallet),
      inbox: { ...message, consumerName: "other-consumer" },
    });

    expect(other.type).toBe("result");
  });
});

describe("ReconcileWallet", () => {
  test("logs a warning on divergence, with no amounts beyond the difference", async () => {
    const wallet = await createWallet(url, "100.00");
    await sql`UPDATE wallets SET balance = 90.00 WHERE id = ${wallet.id}`;
    const warnings: [string, Record<string, unknown>][] = [];
    const reconcile = new ReconcileWallet(realUnitOfWork, { warn: (message, context) => warnings.push([message, context]) });

    const report = await reconcile.execute(wallet.id);

    expect(report.consistent).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toEqual({
      walletId: wallet.id,
      difference: { amount: "-10.00", currency: "BRL" },
      checkedEntries: 1,
    });
  });

  test("does not log when consistent", async () => {
    const wallet = await createWallet(url, "100.00");
    const warnings: unknown[] = [];
    const reconcile = new ReconcileWallet(realUnitOfWork, { warn: (message) => warnings.push(message) });

    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("readiness", () => {
  test("the Postgres check uses the MikroORM connection", async () => {
    await expect(testApp.app.get(PostgresHealthCheck).check()).resolves.toBeUndefined();
  });
});

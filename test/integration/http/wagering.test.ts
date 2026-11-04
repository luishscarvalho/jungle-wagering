import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL } from "bun";
import {
  createWallet,
  expectBalanceMatchesLedger,
  request,
  startTestApp,
  submit,
  type TestApp,
  type TestWallet,
  wagerBody,
} from "../../support/test-app";
import { createTestDatabase, type TestDatabase } from "../db/support";

let db: TestDatabase;
let testApp: TestApp;
let url: string;
let sql: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.orm.migrator.up();
  sql = db.sql;
  testApp = await startTestApp(db.url);
  url = testApp.url;
});

afterAll(async () => {
  await testApp.app.close();
  await db.drop();
});

const money = (amount: string) => ({ amount, currency: "BRL" });

async function ledgerOf(walletId: string) {
  return sql`SELECT * FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY id`;
}

async function transactionRow(id: string) {
  const [row] = await sql`SELECT * FROM wager_transactions WHERE id = ${id}`;
  return row;
}

async function eventsOf(aggregateId: string): Promise<string[]> {
  const rows = await sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${aggregateId} ORDER BY event_type`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

async function balanceOf(wallet: TestWallet) {
  return (await request(url, "GET", `/wallets/${wallet.id}`)).body;
}

async function aProcessed(wallet: TestWallet, overrides: Record<string, unknown> = {}) {
  const body = wagerBody(wallet, overrides);
  const result = await submit(url, body);
  expect(result.status).toBe(200);
  return { body, result: result.body };
}

const reversalOf = (reference: Record<string, unknown>, kind: string, overrides: Record<string, unknown> = {}) => ({
  kind,
  referenceExternalTransactionId: reference.externalTransactionId,
  money: reference.money,
  ...overrides,
});

describe("BET", () => {
  test("debits, writes the ledger and the outbox", async () => {
    const wallet = await createWallet(url, "100.00");
    const result = await submit(url, wagerBody(wallet));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: money("75.00"),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toMatchObject({ balance: money("75.00"), version: 2 });

    const entries = await ledgerOf(wallet.id);
    expect(entries.at(-1)).toMatchObject({
      transaction_id: result.body.transactionId,
      direction: "DEBIT",
      amount: "25.00",
      balance_before: "100.00",
      balance_after: "75.00",
    });

    const row = await transactionRow(result.body.transactionId);
    expect(row).toMatchObject({ status: "PROCESSED", balance_after: "75.00", failure_code: null });
    expect(row.processed_at).toBeInstanceOf(Date);
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(await eventsOf(result.body.transactionId)).toEqual(["WagerTransactionProcessed"]);
    expect(await eventsOf(wallet.id)).toContain("WalletBalanceChanged");
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("without funds is rejected with 422, persisted, with no effect on the balance", async () => {
    const wallet = await createWallet(url, "10.00");
    const result = await submit(url, wagerBody(wallet));

    expect(result.status).toBe(422);
    expect(result.body).toEqual({
      transactionId: expect.any(String),
      status: "REJECTED",
      balance: money("10.00"),
      failureCode: "INSUFFICIENT_FUNDS",
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toMatchObject({ balance: money("10.00"), version: 1 });
    expect(await ledgerOf(wallet.id)).toHaveLength(1);

    const row = await transactionRow(result.body.transactionId);
    expect(row).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", balance_after: "10.00" });
    expect(await eventsOf(result.body.transactionId)).toEqual(["WagerTransactionRejected"]);
    await expectBalanceMatchesLedger(sql, wallet.id, "10.00");
  });
});

describe("WIN", () => {
  test("credits with no reference", async () => {
    const wallet = await createWallet(url, "100.00");
    const { result } = await aProcessed(wallet, { kind: "WIN", money: money("50.00") });

    expect(result.balance).toEqual(money("150.00"));
    expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({ direction: "CREDIT", balance_after: "150.00" });
    await expectBalanceMatchesLedger(sql, wallet.id, "150.00");
  });

  test("credits with a reference to a BET of the same round", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = await aProcessed(wallet);
    const { result } = await aProcessed(wallet, {
      kind: "WIN",
      money: money("60.00"),
      referenceExternalTransactionId: bet.body.externalTransactionId,
    });

    expect(result.balance).toEqual(money("135.00"));
    expect((await transactionRow(result.transactionId)).reference_transaction_id).toBe(bet.result.transactionId);
    await expectBalanceMatchesLedger(sql, wallet.id, "135.00");
  });
});

describe("LOSS", () => {
  test.each(["25.00", "0.00"])("with amount %s records the result without moving the balance", async (amount) => {
    const wallet = await createWallet(url, "100.00");
    const { result } = await aProcessed(wallet, { kind: "LOSS", money: money(amount) });

    expect(result).toMatchObject({ status: "PROCESSED", balance: money("100.00") });
    expect(await balanceOf(wallet)).toMatchObject({ balance: money("100.00"), version: 1 });
    expect(await ledgerOf(wallet.id)).toHaveLength(1);
    expect(await eventsOf(result.transactionId)).toEqual(["WagerTransactionProcessed"]);
    expect(await eventsOf(wallet.id)).toEqual(["WalletBalanceChanged"]);
    expect((await transactionRow(result.transactionId)).balance_after).toBe("100.00");
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });
});

describe("REFUND", () => {
  test("credits a processed BET back", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = await aProcessed(wallet);
    const { result } = await aProcessed(wallet, reversalOf(bet.body, "REFUND"));

    expect(result.balance).toEqual(money("100.00"));
    expect((await transactionRow(result.transactionId)).reference_transaction_id).toBe(bet.result.transactionId);
    expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({ direction: "CREDIT", balance_before: "75.00" });
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("happens only once, and a ROLLBACK of the same BET is also refused", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = await aProcessed(wallet);
    await aProcessed(wallet, reversalOf(bet.body, "REFUND"));

    for (const kind of ["REFUND", "ROLLBACK"]) {
      const second = await submit(url, wagerBody(wallet, reversalOf(bet.body, kind)));
      expect(second.status).toBe(422);
      expect(second.body.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    }
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("with a different amount is rejected", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = await aProcessed(wallet);
    const result = await submit(url, wagerBody(wallet, reversalOf(bet.body, "REFUND", { money: money("24.99") })));

    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe("AMOUNT_MISMATCH");
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("of something other than a BET is rejected", async () => {
    const wallet = await createWallet(url, "100.00");
    const win = await aProcessed(wallet, { kind: "WIN" });
    const result = await submit(url, wagerBody(wallet, reversalOf(win.body, "REFUND")));

    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe("REFERENCE_INVALID_KIND");
  });

  test("of a rejected BET is rejected", async () => {
    const wallet = await createWallet(url, "1.00");
    const body = wagerBody(wallet);
    expect((await submit(url, body)).status).toBe(422);
    const result = await submit(url, wagerBody(wallet, reversalOf(body, "REFUND")));

    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe("REFERENCE_NOT_PROCESSED");
  });

  test("of another wallet's BET is REJECTED with the reference left NULL", async () => {
    const [owner, other] = [await createWallet(url), await createWallet(url)];
    const bet = await aProcessed(owner);
    const result = await submit(url, wagerBody(other, reversalOf(bet.body, "REFUND")));

    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe("REFERENCE_MISMATCH");
    expect(await transactionRow(result.body.transactionId)).toMatchObject({
      status: "REJECTED",
      reference_transaction_id: null,
      reference_external_transaction_id: bet.body.externalTransactionId,
    });
    await expectBalanceMatchesLedger(sql, other.id, "100.00");
  });

  test("of a BET from another round is REJECTED with REFERENCE_MISMATCH", async () => {
    const wallet = await createWallet(url);
    const bet = await aProcessed(wallet, { roundId: "round-1" });
    const result = await submit(url, wagerBody(wallet, reversalOf(bet.body, "REFUND", { roundId: "round-2" })));

    expect(result.status).toBe(422);
    expect(result.body.failureCode).toBe("REFERENCE_MISMATCH");
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = await aProcessed(wallet);
    const { result } = await aProcessed(wallet, reversalOf(bet.body, "ROLLBACK"));

    expect(result.balance).toEqual(money("100.00"));
    expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({ direction: "CREDIT" });
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("of a WIN debits", async () => {
    const wallet = await createWallet(url, "100.00");
    const win = await aProcessed(wallet, { kind: "WIN" });
    const { result } = await aProcessed(wallet, reversalOf(win.body, "ROLLBACK"));

    expect(result.balance).toEqual(money("100.00"));
    expect((await ledgerOf(wallet.id)).at(-1)).toMatchObject({ direction: "DEBIT" });
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test("of a REFUND debits", async () => {
    const wallet = await createWallet(url, "100.00");
    const bet = await aProcessed(wallet);
    const refund = await aProcessed(wallet, reversalOf(bet.body, "REFUND"));
    const { result } = await aProcessed(wallet, reversalOf(refund.body, "ROLLBACK"));

    expect(result.balance).toEqual(money("75.00"));
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("that would make the balance negative uses REVERSAL_INSUFFICIENT_FUNDS", async () => {
    const wallet = await createWallet(url, "0.00");
    const win = await aProcessed(wallet, { kind: "WIN", money: money("100.00") });
    await aProcessed(wallet, { kind: "BET", money: money("60.00") });

    const result = await submit(url, wagerBody(wallet, reversalOf(win.body, "ROLLBACK")));

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      status: "REJECTED",
      failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
      balance: money("40.00"),
    });
    expect((await transactionRow(result.body.transactionId)).reference_transaction_id).toBeNull();
    await expectBalanceMatchesLedger(sql, wallet.id, "40.00");
  });
});

describe("reference out of order", () => {
  test("is accepted with 202, scheduled, with no balance effect, and replays as 202", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet, { kind: "REFUND", referenceExternalTransactionId: "not-arrived-yet" });

    const first = await submit(url, body);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PENDING_REFERENCE",
      balance: null,
      idempotentReplay: false,
    });

    const row = await transactionRow(first.body.transactionId);
    expect(row).toMatchObject({ status: "PENDING_REFERENCE", attempts: 0, balance_after: null });
    expect(row.next_attempt_at).toBeInstanceOf(Date);
    expect(await eventsOf(first.body.transactionId)).toEqual(["WagerTransactionPendingReference"]);
    expect(await ledgerOf(wallet.id)).toHaveLength(1);

    const replay = await submit(url, body);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });
});

describe("idempotency", () => {
  test("a replay returns the original result, with the balance observed at the time", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet);
    const first = await submit(url, body);
    await aProcessed(wallet);

    const replay = await submit(url, body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, balance: money("75.00"), idempotentReplay: true });
    expect(await balanceOf(wallet)).toMatchObject({ balance: money("50.00") });
    await expectBalanceMatchesLedger(sql, wallet.id, "50.00");
  });

  test("a replay of a LOSS returns the balance observed at the time", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet, { kind: "LOSS" });
    await submit(url, body);
    await aProcessed(wallet);

    const replay = await submit(url, body);
    expect(replay.body).toMatchObject({ balance: money("100.00"), idempotentReplay: true });
  });

  test("a replay of a rejection repeats the 422, even if funds exist now", async () => {
    const wallet = await createWallet(url, "10.00");
    const body = wagerBody(wallet);
    const first = await submit(url, body);
    await aProcessed(wallet, { kind: "WIN", money: money("500.00") });

    const replay = await submit(url, body);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    await expectBalanceMatchesLedger(sql, wallet.id, "510.00");
  });

  test("a replay writes no new transaction, ledger entry or event", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet);
    const first = await submit(url, body);
    const [counts] = await sql`SELECT count(*)::int AS events FROM outbox_messages`;

    await submit(url, body);

    const [after] = await sql`SELECT count(*)::int AS events FROM outbox_messages`;
    expect(after.events).toBe(counts.events);
    expect(await ledgerOf(wallet.id)).toHaveLength(2);
    expect(first.status).toBe(200);
  });

  test.each([
    ["amount", { money: money("26.00") }],
    ["round", { roundId: "round-2" }],
    ["game", { gameId: "other-game" }],
    ["kind", { kind: "WIN" }],
  ])("the same key with a divergent %s is a 409, not a replay", async (_label, overrides) => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet);
    const key = `key-${randomUUIDv7()}`;
    await submit(url, body, key);

    const conflict = await submit(url, { ...body, ...overrides }, key);

    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("the same key on another wallet is a 409", async () => {
    const [walletA, walletB] = [await createWallet(url), await createWallet(url)];
    const key = `key-${randomUUIDv7()}`;
    await submit(url, wagerBody(walletA), key);

    const conflict = await submit(url, wagerBody(walletB), key);

    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
    await expectBalanceMatchesLedger(sql, walletB.id, "100.00");
  });

  test("the same provider and external id under another key is a 409", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet);
    await submit(url, body, `key-${randomUUIDv7()}`);

    const conflict = await submit(url, body, `key-${randomUUIDv7()}`);

    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe("IDEMPOTENCY_CONFLICT");
    await expectBalanceMatchesLedger(sql, wallet.id, "75.00");
  });

  test("an uppercase UUID is the same payload as the lowercase one", async () => {
    const wallet = await createWallet(url, "100.00");
    const body = wagerBody(wallet);
    await submit(url, body);

    const upper = { ...body, walletId: wallet.id.toUpperCase(), playerId: wallet.playerId.toUpperCase() };
    const replay = await submit(url, upper);

    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });
});

describe("refused before persisting", () => {
  async function expectNoRowsFor(key: string) {
    const rows = await sql`SELECT id FROM wager_transactions WHERE idempotency_key = ${key}`;
    expect(rows).toHaveLength(0);
  }

  test("an unknown wallet is a 404", async () => {
    const wallet = await createWallet(url);
    const key = `key-${randomUUIDv7()}`;
    const result = await submit(url, wagerBody(wallet, { walletId: randomUUIDv7() }), key);

    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("WALLET_NOT_FOUND");
    await expectNoRowsFor(key);
  });

  test("a different currency is a 400", async () => {
    const wallet = await createWallet(url);
    const key = `key-${randomUUIDv7()}`;
    const result = await submit(url, wagerBody(wallet, { money: { amount: "1.00", currency: "USD" } }), key);

    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("CURRENCY_MISMATCH");
    await expectNoRowsFor(key);
  });

  test("a different player is a 400", async () => {
    const wallet = await createWallet(url);
    const key = `key-${randomUUIDv7()}`;
    const result = await submit(url, wagerBody(wallet, { playerId: randomUUIDv7() }), key);

    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("PLAYER_MISMATCH");
    await expectNoRowsFor(key);
  });

  test("OPENING from outside is a 400 with KIND_NOT_ALLOWED", async () => {
    const wallet = await createWallet(url);
    const result = await submit(url, wagerBody(wallet, { kind: "OPENING" }));

    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("KIND_NOT_ALLOWED");
  });

  test("a missing Idempotency-Key is a 400", async () => {
    const wallet = await createWallet(url);
    const result = await request(url, "POST", "/wagering/transactions", wagerBody(wallet));

    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
  });

  const invalidPayloads: [string, Record<string, unknown>][] = [
    ["unknown kind", { kind: "JACKPOT" }],
    ["number as amount", { money: { amount: 25, currency: "BRL" } }],
    ["amount with no places", { money: money("25") }],
    ["amount in scientific notation", { money: money("1e3") }],
    ["negative amount", { money: money("-1.00") }],
    ["zero BET", { money: money("0.00") }],
    ["amount over the column limit", { money: money("1000000000000000000.00") }],
    ["lowercase currency", { money: { amount: "1.00", currency: "brl" } }],
    ["missing money", { money: undefined }],
    ["non-UUID wallet", { walletId: "wallet-1" }],
    ["non-UUID player", { playerId: "player-1" }],
    ["missing round", { roundId: undefined }],
    ["empty game", { gameId: "" }],
    ["NUL in text", { roundId: "a\u0000b" }],
    ["reserved provider id", { providerId: "internal" }],
    ["BET with a reference", { referenceExternalTransactionId: "ext" }],
    ["REFUND with no reference", { kind: "REFUND" }],
  ];

  test.each(invalidPayloads)("%s is a 400 with INVALID_PAYLOAD", async (_label, overrides) => {
    const wallet = await createWallet(url);
    const result = await submit(url, wagerBody(wallet, overrides));

    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
    await expectBalanceMatchesLedger(sql, wallet.id, "100.00");
  });

  test.each([
    ["array", "[]"],
    ["malformed JSON", "{not json"],
  ])("a body that is %s is a 400 with INVALID_PAYLOAD", async (_label, body) => {
    const result = await request(url, "POST", "/wagering/transactions", body, { "idempotency-key": "k" });
    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
  });
});

describe("transaction queries", () => {
  test("by id and by provider and external id return the same transaction", async () => {
    const wallet = await createWallet(url);
    const { body, result } = await aProcessed(wallet);

    const byId = await request(url, "GET", `/wagering/transactions/${result.transactionId}`);
    const byExternal = await request(
      url,
      "GET",
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({
      id: result.transactionId,
      providerId: "provider-a",
      kind: "BET",
      status: "PROCESSED",
      money: money("25.00"),
      balanceAfter: money("75.00"),
      failureCode: null,
      attempts: 0,
    });
  });

  test("an unknown id is a 404 with RESOURCE_NOT_FOUND", async () => {
    const result = await request(url, "GET", `/wagering/transactions/${randomUUIDv7()}`);
    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("RESOURCE_NOT_FOUND");
  });

  test("an unknown external id is a 404", async () => {
    const result = await request(url, "GET", "/providers/provider-a/wagering/transactions/nope");
    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("RESOURCE_NOT_FOUND");
  });

  test("a malformed id is a 400", async () => {
    const result = await request(url, "GET", "/wagering/transactions/not-a-uuid");
    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
  });
});

describe("framework errors", () => {
  test("an unknown route also carries a failureCode", async () => {
    const result = await request(url, "GET", "/nope");
    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("RESOURCE_NOT_FOUND");
  });
});

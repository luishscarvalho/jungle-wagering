import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUIDv7, type SQL } from "bun";
import {
  createWallet,
  expectBalanceMatchesLedger,
  request,
  startTestApp,
  submit,
  type TestApp,
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

describe("POST /wallets", () => {
  test("with a positive balance writes OPENING, a CREDIT entry and events, keeping version 1", async () => {
    const playerId = randomUUIDv7();
    const result = await request(url, "POST", "/wallets", { playerId, initialBalance: money("1000.00") });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: expect.any(String), playerId, balance: money("1000.00"), version: 1 });
    const walletId = result.body.id;

    const [opening] = await sql`SELECT * FROM wager_transactions WHERE wallet_id = ${walletId}`;
    expect(opening).toMatchObject({
      kind: "OPENING",
      status: "PROCESSED",
      provider_id: "internal",
      external_transaction_id: `opening:${walletId}`,
      idempotency_key: `internal:opening:${walletId}`,
      round_id: "opening",
      game_id: "opening",
      amount: "1000.00",
      balance_after: "1000.00",
    });

    const entries = await sql`SELECT * FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transaction_id: opening.id,
      direction: "CREDIT",
      amount: "1000.00",
      balance_before: "0.00",
      balance_after: "1000.00",
    });

    const events = await sql`
      SELECT event_type, payload FROM outbox_messages
       WHERE aggregate_id IN (${walletId}, ${opening.id}) ORDER BY event_type
    `;
    expect(events.map((event: { event_type: string }) => event.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(events[1].payload.data).toMatchObject({ walletVersion: 1, balanceAfter: money("1000.00") });
    await expectBalanceMatchesLedger(sql, walletId, "1000.00");
  });

  test("with a zero balance writes no OPENING and no ledger", async () => {
    const wallet = await createWallet(url, "0.00");
    expect(wallet.version).toBe(1);
    expect(await sql`SELECT id FROM wager_transactions WHERE wallet_id = ${wallet.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM wallet_ledger_entries WHERE wallet_id = ${wallet.id}`).toHaveLength(0);
    await expectBalanceMatchesLedger(sql, wallet.id, "0.00");
  });

  test("keeps large values exact", async () => {
    const wallet = await createWallet(url, "99999999999999999.99");
    expect(wallet.balance.amount).toBe("99999999999999999.99");
    await expectBalanceMatchesLedger(sql, wallet.id, "99999999999999999.99");
  });

  test("a duplicate for the same player and currency is a 409, writing nothing", async () => {
    const playerId = randomUUIDv7();
    await request(url, "POST", "/wallets", { playerId, initialBalance: money("10.00") });
    const result = await request(url, "POST", "/wallets", { playerId, initialBalance: money("20.00") });

    expect(result.status).toBe(409);
    expect(result.body.failureCode).toBe("WALLET_ALREADY_EXISTS");
    expect(await sql`SELECT id FROM wager_transactions WHERE player_id = ${playerId}`).toHaveLength(1);
  });

  test("the same player can have a wallet in another currency", async () => {
    const playerId = randomUUIDv7();
    await request(url, "POST", "/wallets", { playerId, initialBalance: money("10.00") });
    const result = await request(url, "POST", "/wallets", {
      playerId,
      initialBalance: { amount: "10.00", currency: "USD" },
    });
    expect(result.status).toBe(201);
  });

  test.each([
    ["non-UUID player", { playerId: "player-1", initialBalance: money("1.00") }],
    ["missing balance", { playerId: randomUUIDv7() }],
    ["negative balance", { playerId: randomUUIDv7(), initialBalance: money("-1.00") }],
    ["number as balance", { playerId: randomUUIDv7(), initialBalance: { amount: 1, currency: "BRL" } }],
    ["balance over the column limit", { playerId: randomUUIDv7(), initialBalance: money("1000000000000000000.00") }],
  ])("%s is a 400 with INVALID_PAYLOAD", async (_label, body) => {
    const result = await request(url, "POST", "/wallets", body);
    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets/:id", () => {
  test("returns the wallet", async () => {
    const wallet = await createWallet(url, "12.34");
    const result = await request(url, "GET", `/wallets/${wallet.id}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: money("12.34"), version: 1 });
  });

  test("an unknown wallet is a 404", async () => {
    const result = await request(url, "GET", `/wallets/${randomUUIDv7()}`);
    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("WALLET_NOT_FOUND");
  });

  test("a malformed id is a 400", async () => {
    const result = await request(url, "GET", "/wallets/not-a-uuid");
    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets/:id/ledger", () => {
  async function walletWithBets(bets: number) {
    const wallet = await createWallet(url, "1000.00");
    for (let i = 0; i < bets; i++) {
      await submit(url, wagerBody(wallet, { money: money("1.00") }));
    }
    return wallet;
  }

  test("pages through every entry exactly once, oldest first", async () => {
    const wallet = await walletWithBets(4);
    const seen: string[] = [];
    const balances: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await request(url, "GET", `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      for (const item of page.body.items) {
        seen.push(item.id);
        balances.push(item.balanceAfter.amount);
      }
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort());
    expect(balances).toEqual(["1000.00", "999.00", "998.00", "997.00", "996.00"]);
  });

  test("an entry has the contract shape", async () => {
    const wallet = await createWallet(url, "10.00");
    const page = await request(url, "GET", `/wallets/${wallet.id}/ledger`);
    expect(page.body.items[0]).toEqual({
      id: expect.any(String),
      walletId: wallet.id,
      transactionId: expect.any(String),
      direction: "CREDIT",
      money: money("10.00"),
      balanceBefore: money("0.00"),
      balanceAfter: money("10.00"),
      createdAt: expect.any(String),
    });
  });

  test("has no next cursor when the page is exactly the last one", async () => {
    const wallet = await walletWithBets(1);
    const page = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=2`);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBeNull();
  });

  test("a cursor stays stable when new entries arrive", async () => {
    const wallet = await walletWithBets(2);
    const first = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=2`);
    await submit(url, wagerBody(wallet, { money: money("1.00") }));

    const second = await request(url, "GET", `/wallets/${wallet.id}/ledger?cursor=${first.body.nextCursor}`);

    const firstIds = first.body.items.map((item: { id: string }) => item.id);
    const secondIds = second.body.items.map((item: { id: string }) => item.id);
    expect(secondIds).toHaveLength(2);
    expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
  });

  test("the cursor is base64 of the last entry id", async () => {
    const wallet = await walletWithBets(1);
    const page = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=1`);
    expect(Buffer.from(page.body.nextCursor, "base64url").toString()).toBe(page.body.items[0].id);
  });

  test("defaults to 50 entries and allows up to 200", async () => {
    const wallet = await walletWithBets(51);
    const byDefault = await request(url, "GET", `/wallets/${wallet.id}/ledger`);
    expect(byDefault.body.items).toHaveLength(50);
    expect(byDefault.body.nextCursor).not.toBeNull();

    const atMax = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=200`);
    expect(atMax.body.items).toHaveLength(52);
    expect(atMax.body.nextCursor).toBeNull();
  });

  test.each(["0", "201", "-1", "abc", "1.5", ""])("limit %j is a 400", async (limit) => {
    const wallet = await createWallet(url);
    const result = await request(url, "GET", `/wallets/${wallet.id}/ledger?limit=${limit}`);
    expect(result.status).toBe(400);
    expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
  });

  test.each(["not-base64-uuid", "", Buffer.from("not-a-uuid").toString("base64url")])(
    "cursor %j is a 400",
    async (cursor) => {
      const wallet = await createWallet(url);
      const result = await request(url, "GET", `/wallets/${wallet.id}/ledger?cursor=${cursor}`);
      expect(result.status).toBe(400);
      expect(result.body.failureCode).toBe("INVALID_PAYLOAD");
    },
  );

  test("an unknown wallet is a 404", async () => {
    const result = await request(url, "GET", `/wallets/${randomUUIDv7()}/ledger`);
    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("WALLET_NOT_FOUND");
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("reports a consistent wallet after several movements", async () => {
    const wallet = await createWallet(url, "1000.00");
    await submit(url, wagerBody(wallet));
    await submit(url, wagerBody(wallet, { kind: "WIN", money: money("5.50") }));
    await submit(url, wagerBody(wallet, { kind: "LOSS" }));

    const result = await request(url, "POST", `/wallets/${wallet.id}/reconciliation`);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: money("980.50"),
      calculatedBalance: money("980.50"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 3,
    });
  });

  test("reports a zero-balance wallet with no entries as consistent", async () => {
    const wallet = await createWallet(url, "0.00");
    const result = await request(url, "POST", `/wallets/${wallet.id}/reconciliation`);
    expect(result.body).toMatchObject({ consistent: true, checkedEntries: 0, calculatedBalance: money("0.00") });
  });

  test.each([
    ["above", "150.00", "50.00"],
    ["below", "60.00", "-40.00"],
  ])("flags a stored balance %s the ledger and does not correct it", async (_label, tampered, difference) => {
    const wallet = await createWallet(url, "100.00");
    await sql`UPDATE wallets SET balance = ${tampered} WHERE id = ${wallet.id}`;

    const result = await request(url, "POST", `/wallets/${wallet.id}/reconciliation`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      consistent: false,
      storedBalance: money(tampered),
      calculatedBalance: money("100.00"),
      difference: money(difference),
    });
    const [row] = await sql`SELECT balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe(tampered);
  });

  test("an unknown wallet is a 404", async () => {
    const result = await request(url, "POST", `/wallets/${randomUUIDv7()}/reconciliation`);
    expect(result.status).toBe(404);
    expect(result.body.failureCode).toBe("WALLET_NOT_FOUND");
  });
});

describe("GET /health/live", () => {
  test("is open and 200", async () => {
    const result = await request(url, "GET", "/health/live");
    expect(result.status).toBe(200);
  });
});

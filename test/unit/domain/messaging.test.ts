import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../../src/domain/events/events";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { InvalidMessageStateError } from "../../../src/domain/messaging/messaging.errors";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { AT, aWallet, brl, LATER } from "./fixtures";

const secondsAfter = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

describe("InboxMessage", () => {
  const received = () =>
    InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: AT });

  test("starts unprocessed", () => {
    const message = received();
    expect(message).toMatchObject({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: AT });
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test("markProcessed records the time", () => {
    const message = received();
    message.markProcessed(LATER);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(LATER);
  });

  test("cannot be processed twice", () => {
    const message = received();
    message.markProcessed(AT);
    expect(() => message.markProcessed(LATER)).toThrow(InvalidMessageStateError);
    expect(message.processedAt).toEqual(AT);
  });

  test("rehydrate restores the processed state", () => {
    const message = InboxMessage.rehydrate({
      messageId: "m",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: AT,
      processedAt: LATER,
    });
    expect(message.isProcessed()).toBe(true);
  });
});

describe("OutboxMessage", () => {
  const event = () => {
    const wallet = aWallet("100.00");
    const entry = wallet.debit({ entryId: "e", transactionId: "t", money: brl("25.00"), at: AT });
    return WalletBalanceChanged.from(wallet, entry, { eventId: "evt-1", correlationId: "c", occurredAt: AT });
  };

  test("enqueue copies the event and is due right away", () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);
    expect(message).toMatchObject({
      id: "evt-1",
      aggregateId: source.aggregateId,
      eventType: "WalletBalanceChanged",
      occurredAt: AT,
    });
    expect(message.payload).toEqual(source.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(AT)).toBe(true);
  });

  test("the payload survives a JSON round trip, as it does in jsonb", () => {
    const message = OutboxMessage.enqueue(event());
    expect(JSON.parse(JSON.stringify(message.payload))).toEqual(message.payload);
  });

  test("scheduleRetry increments attempts and backs off, capped at 60s", () => {
    const message = OutboxMessage.enqueue(event());
    const expected = [1, 2, 4, 8, 16, 32, 60, 60];
    expected.forEach((delay, index) => {
      message.scheduleRetry(LATER);
      expect(message.attempts).toBe(index + 1);
      expect(message.nextAttemptAt).toEqual(secondsAfter(LATER, delay));
    });
  });

  test("has no attempt limit, so a committed event is never given up on", () => {
    const message = OutboxMessage.enqueue(event());
    for (let i = 0; i < 1000; i++) message.scheduleRetry(LATER);
    expect(message.attempts).toBe(1000);
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt).toEqual(secondsAfter(LATER, 60));
  });

  test("isDue follows nextAttemptAt", () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(AT);
    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(secondsAfter(AT, 1))).toBe(true);
  });

  test("markPublished ends the pending state", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(LATER);
    expect(message.publishedAt).toEqual(LATER);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(LATER)).toBe(false);
  });

  test("cannot be published twice or retried after publishing", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(AT);
    expect(() => message.markPublished(LATER)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(LATER)).toThrow(InvalidMessageStateError);
    expect(message.publishedAt).toEqual(AT);
    expect(message.attempts).toBe(0);
  });

  test("rehydrate restores attempts and schedule", () => {
    const message = OutboxMessage.rehydrate({
      id: "o",
      aggregateId: "a",
      eventType: "X",
      payload: {},
      occurredAt: AT,
      attempts: 3,
      nextAttemptAt: LATER,
    });
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt).toEqual(LATER);
  });
});

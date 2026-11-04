import type { IntegrationEvent } from "../events/integration-event";
import { type BackoffPolicy, nextAttemptAfter } from "../shared/backoff";
import { InvalidMessageStateError } from "./messaging.errors";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = state.payload;
    this.occurredAt = state.occurredAt;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt;
    this._publishedAt = state.publishedAt;
  }

  /** Reuses eventId as the id, so the row and the published event share one identity. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /** No attempt limit: a committed event must never be lost. */
  scheduleRetry(now: Date, backoff?: BackoffPolicy): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAfter(now, this._attempts, backoff);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Outbox message ${this.id} is already published`);
    }
  }
}

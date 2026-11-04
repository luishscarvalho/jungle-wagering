import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { BackoffPolicy } from "../../domain/shared/backoff";
import type { AppLogger, Clock, EventPublisher, Metrics, UnitOfWork } from "../ports";

const BATCH_SIZE = 50;

/**
 * One round of the transactional outbox. A crash between publishing and the commit
 * publishes again with the same eventId, which is why delivery is at-least-once.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Pick<Metrics, "retryScheduled">,
    private readonly backoff?: BackoffPolicy,
  ) {}

  /** Returns whether it is worth running again right away. */
  async runRound(): Promise<boolean> {
    const { published, failed } = await this.unitOfWork.transaction(async (repositories) => {
      const batch = await repositories.outbox.lockDueBatch(BATCH_SIZE);

      const byAggregate = new Map<string, OutboxMessage[]>();
      for (const message of batch) {
        const group = byAggregate.get(message.aggregateId);
        if (group) group.push(message);
        else byAggregate.set(message.aggregateId, [message]);
      }

      // In parallel so that a slow broker holds these row locks for one request timeout, not 50.
      const touched = await Promise.all([...byAggregate.values()].map((group) => this.publishInOrder(group)));

      const messages = touched.flat();
      for (const message of messages) await repositories.outbox.update(message);
      const published = messages.filter((message) => !message.isPending()).length;
      return { published, failed: messages.length - published };
    });

    for (let i = 0; i < failed; i++) this.metrics.retryScheduled("outbox");
    return published > 0;
  }

  /** Stops at the first failure: what comes after it stays untouched, keeping the aggregate's order. */
  private async publishInOrder(group: OutboxMessage[]): Promise<OutboxMessage[]> {
    const touched: OutboxMessage[] = [];
    for (const message of group) {
      touched.push(message);
      const context = {
        eventId: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        correlationId: message.payload.correlationId,
      };
      try {
        await this.publisher.publish(message);
      } catch (error) {
        message.scheduleRetry(this.clock.now(), this.backoff);
        this.logger.warn("Outbox publish failed", {
          ...context,
          attempts: message.attempts,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return touched;
      }
      message.markPublished(this.clock.now());
      this.logger.info("Outbox event published", context);
    }
    return touched;
  }
}

import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { crashIfRequested } from "../test-hooks";

export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    this.queueUrl ??= (await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }))).QueueUrl;
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
    crashIfRequested("TEST_CRASH_AFTER_PUBLISH");
  }
}

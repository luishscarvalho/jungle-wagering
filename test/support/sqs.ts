import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { randomUUIDv7 } from "bun";
import type { TestWallet } from "./test-app";
import { wagerBody } from "./test-app";

export const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
export const SQS_REGION = process.env.AWS_REGION ?? "us-east-1";

export function createSqsClient(): SQSClient {
  return new SQSClient({ region: SQS_REGION, endpoint: SQS_ENDPOINT });
}

export interface TestQueues {
  client: SQSClient;
  queueName: string;
  queueUrl: string;
  dlqName: string;
  dlqUrl: string;
  eventsQueueName: string;
  eventsUrl: string;
  drop(): Promise<void>;
}

/** A queue pair per test, created like infra/sqs/create-queues.sh, so tests share no messages. */
export async function createTestQueues(maxReceiveCount = 5): Promise<TestQueues> {
  const client = createSqsClient();
  const suffix = randomUUIDv7().replaceAll("-", "");
  const dlqName = `test-dlq-${suffix}.fifo`;
  const queueName = `test-${suffix}.fifo`;
  const eventsQueueName = `test-events-${suffix}.fifo`;

  const dlq = await client.send(new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: "true" } }));
  const dlqUrl = dlq.QueueUrl as string;
  const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
  const queue = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: "true",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attributes.Attributes?.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  const queueUrl = queue.QueueUrl as string;
  const events = await client.send(
    new CreateQueueCommand({
      QueueName: eventsQueueName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );
  const eventsUrl = events.QueueUrl as string;

  return {
    client,
    queueName,
    queueUrl,
    dlqName,
    dlqUrl,
    eventsQueueName,
    eventsUrl,
    async drop() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: eventsUrl }));
      client.destroy();
    },
  };
}

export interface MessageOptions {
  messageId?: string;
  dataOverrides?: Record<string, unknown>;
}

export function wagerMessage(wallet: TestWallet, options: MessageOptions = {}) {
  const data = wagerBody(wallet, options.dataOverrides);
  return {
    messageId: options.messageId ?? randomUUIDv7(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` } as Record<string, unknown> & {
      walletId: string;
      idempotencyKey: string;
    },
  };
}

/** A fresh deduplication id by default, which is how a redelivery past the 5 minute window looks to SQS. */
export async function sendRaw(queues: TestQueues, body: string, groupId: string): Promise<string> {
  const sent = await queues.client.send(
    new SendMessageCommand({
      QueueUrl: queues.queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUIDv7(),
    }),
  );
  return sent.MessageId as string;
}

export function sendMessage(queues: TestQueues, message: ReturnType<typeof wagerMessage>): Promise<string> {
  return sendRaw(queues, JSON.stringify(message), message.data.walletId);
}

export interface QueueCounts {
  visible: number;
  inFlight: number;
}

export async function queueCounts(queues: TestQueues, queueUrl = queues.queueUrl): Promise<QueueCounts> {
  const { Attributes } = await queues.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(Attributes?.ApproximateNumberOfMessages),
    inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible),
  };
}

/** Reads the DLQ with a short visibility, so it can be read again. */
export async function readDlq(queues: TestQueues): Promise<Message[]> {
  const { Messages } = await queues.client.send(
    new ReceiveMessageCommand({
      QueueUrl: queues.dlqUrl,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 0,
      MessageAttributeNames: ["All"],
    }),
  );
  return Messages ?? [];
}

export interface PublishedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  data: Record<string, unknown>;
  groupId: string | undefined;
}

/** Consumes what is in the events queue right now, in arrival order. */
export async function takeEvents(queues: TestQueues): Promise<PublishedEvent[]> {
  const taken: PublishedEvent[] = [];
  for (;;) {
    const { Messages } = await queues.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventsUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    if (!Messages?.length) return taken;
    for (const message of Messages) {
      taken.push({ ...JSON.parse(message.Body as string), groupId: message.Attributes?.MessageGroupId });
      await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.eventsUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

export async function eventually<T>(
  check: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (accept(value)) return value;
    if (performance.now() > deadline) throw new Error(`Timed out, last value: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

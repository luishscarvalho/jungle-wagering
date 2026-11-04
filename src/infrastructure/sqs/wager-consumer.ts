import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { AppLogger, Metrics } from "../../application/ports";
import type { ProcessWagerResult, ProcessWagerTransaction } from "../../application/wager/process-wager-transaction";
import { backoffDelayMs } from "../../domain/shared/backoff";
import { FailureCode } from "../../domain/shared/failure-code";
import { crashIfRequested } from "../test-hooks";
import { describeError, isTransientInfrastructureError } from "../transient-errors";
import { parseWagerMessage, type WagerMessage } from "./wager-message";

export const WAGER_CONSUMER_NAME = "wager-processor";

const WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 10;

export interface WagerConsumerOptions {
  queueName: string;
  dlqName: string;
  /**
   * Must outlast a whole batch of one group, which runs in sequence. Each message waits
   * at most the 5s lock_timeout on the wallet, so 60s covers 10 of them. Going over it
   * only causes a redelivery, which the inbox absorbs.
   */
  visibilityTimeoutSeconds: number;
  shutdownGraceMs: number;
}

interface Delivery {
  message: Message;
  /** Released on shutdown: the broker may hand it to another instance, so this one no longer settles it. */
  released: boolean;
}

/** How long to hide a message that was not settled. Undefined means it left the queue. */
type Settlement = { retryAfterSeconds: number } | undefined;

function receiveCountOf(message: Message): number {
  const count = Number(message.Attributes?.ApproximateReceiveCount);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function groupOf(message: Message): string {
  return message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
}

function logContext(delivery: Delivery, parsed?: WagerMessage): Record<string, unknown> {
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    sqsMessageId: delivery.message.MessageId,
    messageId: parsed?.messageId,
    correlationId: text(parsed?.data.idempotencyKey),
    walletId: text(parsed?.data.walletId),
    providerId: text(parsed?.data.providerId),
    receiveCount: receiveCountOf(delivery.message),
  };
}

export class WagerConsumer {
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Delivery>();
  private loop: Promise<void> | undefined;
  private stopped: Promise<void> | undefined;
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly logger: AppLogger,
    private readonly metrics: Pick<Metrics, "retryScheduled" | "deadLettered">,
    private readonly options: WagerConsumerOptions,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops polling, waits for what is running, and hands back whatever did not finish in time. */
  stop(): Promise<void> {
    this.stopped ??= this.drain();
    return this.stopped;
  }

  private get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  private async drain(): Promise<void> {
    this.abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.shutdownGraceMs);
    });
    await Promise.race([this.loop, graceOver]);
    clearTimeout(timer);

    await this.changeVisibility([...this.inFlight], 0);
    this.client.destroy();
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      try {
        const messages = await this.receive();
        failures = 0;
        await this.processBatch(messages);
      } catch (error) {
        if (this.stopping) return;
        failures += 1;
        const retryInMs = backoffDelayMs(failures);
        this.logger.error("SQS poll failed", { ...describeError(error), failures, retryInMs });
        await this.pause(retryInMs);
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async receive(): Promise<Message[]> {
    const output = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MaxNumberOfMessages: MAX_MESSAGES,
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: this.abort.signal },
    );
    return output.Messages ?? [];
  }

  private async resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= (
      await this.client.send(new GetQueueUrlCommand({ QueueName: this.options.queueName }), {
        abortSignal: this.abort.signal,
      })
    ).QueueUrl;
    if (!this.queueUrl) throw new Error("SQS returned no queue URL");
    return this.queueUrl;
  }

  /** Groups run in parallel. Inside a group the order is kept, which is what FIFO promised. */
  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Delivery[]>();
    for (const message of messages) {
      const delivery: Delivery = { message, released: false };
      this.inFlight.add(delivery);
      const group = groups.get(groupOf(message));
      if (group) group.push(delivery);
      else groups.set(groupOf(message), [delivery]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async processGroup(group: Delivery[]): Promise<void> {
    for (const [index, delivery] of group.entries()) {
      if (this.stopping) {
        await this.changeVisibility(group.slice(index), 0);
        return;
      }
      const settlement = await this.handle(delivery);
      if (settlement) {
        // Going on would apply later messages of this group before the one that failed.
        await this.changeVisibility(group.slice(index), settlement.retryAfterSeconds);
        return;
      }
    }
  }

  private async handle(delivery: Delivery): Promise<Settlement> {
    let parsed: WagerMessage;
    try {
      parsed = parseWagerMessage(delivery.message.Body);
    } catch {
      return this.deadLetter(delivery, "MALFORMED_MESSAGE", undefined);
    }

    let result: ProcessWagerResult;
    try {
      result = await this.processWager.execute({
        idempotencyKey: parsed.data.idempotencyKey,
        payload: parsed.data,
        causationId: parsed.messageId,
        inbox: { messageId: parsed.messageId, consumerName: WAGER_CONSUMER_NAME, payloadHash: parsed.payloadHash },
      });
    } catch (error) {
      const context = { ...logContext(delivery, parsed), ...describeError(error) };
      if (isTransientInfrastructureError(error)) {
        this.logger.warn("Transient failure processing message", context);
        return this.retrySettlement(delivery);
      }
      this.logger.error("Permanent failure processing message", context);
      return this.deadLetter(delivery, FailureCode.ProcessingFailed, parsed);
    }

    crashIfRequested("TEST_CRASH_AFTER_COMMIT");
    return this.settle(delivery, parsed, result);
  }

  private settle(delivery: Delivery, parsed: WagerMessage, result: ProcessWagerResult): Promise<Settlement> {
    const context = logContext(delivery, parsed);
    switch (result.type) {
      case "result":
        this.logger.info("Message processed", {
          ...context,
          transactionId: result.view.transactionId,
          status: result.view.status,
          failureCode: result.view.failureCode,
          idempotentReplay: result.view.idempotentReplay,
        });
        return this.ack(delivery, parsed);
      case "duplicate-message":
        this.logger.info("Duplicate message ignored", context);
        return this.ack(delivery, parsed);
      case "message-conflict":
        return this.deadLetter(delivery, "MESSAGE_ID_CONFLICT", parsed);
      case "refused":
        if (result.failureCode === FailureCode.InvalidPayload) {
          return this.deadLetter(delivery, FailureCode.InvalidPayload, parsed);
        }
        this.logger.info("Message refused", { ...context, failureCode: result.failureCode });
        return this.ack(delivery, parsed);
    }
  }

  /** Runs after the commit. If the delete fails the message comes back and the inbox answers it. */
  private async ack(delivery: Delivery, parsed?: WagerMessage): Promise<Settlement> {
    this.inFlight.delete(delivery);
    if (delivery.released) return undefined;
    try {
      await this.deleteFromQueue(delivery);
    } catch (error) {
      this.logger.warn("Ack failed, the inbox will absorb the redelivery", {
        ...logContext(delivery, parsed),
        ...describeError(error),
      });
    }
    return undefined;
  }

  private deleteFromQueue(delivery: Delivery): Promise<unknown> {
    return this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: delivery.message.ReceiptHandle }),
    );
  }

  /**
   * Sent before the delete: a crash in between leaves the message in the queue, and the
   * redelivery reuses the SQS message id as deduplication id, so the DLQ holds one copy.
   */
  private async deadLetter(delivery: Delivery, reason: string, parsed: WagerMessage | undefined): Promise<Settlement> {
    const context = { ...logContext(delivery, parsed), reason };
    if (delivery.released) {
      this.inFlight.delete(delivery);
      return undefined;
    }
    try {
      this.dlqUrl ??= (await this.client.send(new GetQueueUrlCommand({ QueueName: this.options.dlqName }))).QueueUrl;
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.dlqUrl,
          MessageBody: delivery.message.Body,
          MessageGroupId: groupOf(delivery.message),
          MessageDeduplicationId: delivery.message.MessageId,
          MessageAttributes: { failureReason: { DataType: "String", StringValue: reason } },
        }),
      );
    } catch (error) {
      this.logger.error("Could not send message to the DLQ, retrying", { ...context, ...describeError(error) });
      return this.retrySettlement(delivery);
    }

    this.metrics.deadLettered(reason);
    this.logger.error("Message sent to the DLQ", context);
    return this.ack(delivery, parsed);
  }

  private retrySettlement(delivery: Delivery): Settlement {
    this.metrics.retryScheduled("sqs");
    return { retryAfterSeconds: Math.ceil(backoffDelayMs(receiveCountOf(delivery.message)) / 1000) };
  }

  private async changeVisibility(deliveries: Delivery[], seconds: number): Promise<void> {
    await Promise.all(
      deliveries.map(async (delivery) => {
        this.inFlight.delete(delivery);
        if (delivery.released) return;
        if (seconds === 0) delivery.released = true;
        try {
          await this.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: delivery.message.ReceiptHandle,
              VisibilityTimeout: seconds,
            }),
          );
        } catch (error) {
          // The visibility timeout still brings the message back, only later than asked.
          this.logger.warn("Could not change message visibility", { ...logContext(delivery), ...describeError(error) });
        }
      }),
    );
  }
}

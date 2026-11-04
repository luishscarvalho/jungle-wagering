/**
 * Publishes a test message to the wager queue.
 *
 *   bun run sqs:send --wallet <id> --player <id> [--kind BET] [--amount 25.00] [--currency BRL]
 *                    [--external-id <id>] [--provider provider-a] [--round round-1] [--game fortune-chimp]
 *                    [--reference <external id>] [--message-id <id>] [--idempotency-key <key>]
 *   bun run sqs:send --wallet <id> --raw 'not json'     sends the body as is, to exercise the DLQ
 */
import { parseArgs } from "node:util";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { randomUUIDv7 } from "bun";

const { values: args } = parseArgs({
  options: {
    wallet: { type: "string" },
    player: { type: "string" },
    kind: { type: "string", default: "BET" },
    amount: { type: "string", default: "25.00" },
    currency: { type: "string", default: "BRL" },
    provider: { type: "string", default: "provider-a" },
    round: { type: "string", default: "round-1" },
    game: { type: "string", default: "fortune-chimp" },
    "external-id": { type: "string" },
    reference: { type: "string" },
    "message-id": { type: "string" },
    "idempotency-key": { type: "string" },
    raw: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const walletId = args.wallet ?? fail("--wallet is required: it is the MessageGroupId");
if (args.raw === undefined && !args.player) fail("--player is required");

const messageId = args["message-id"] ?? randomUUIDv7();
const externalTransactionId = args["external-id"] ?? randomUUIDv7();
const body =
  args.raw ??
  JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: args.provider,
      externalTransactionId,
      idempotencyKey: args["idempotency-key"] ?? `${args.provider}:${externalTransactionId}`,
      playerId: args.player,
      walletId,
      roundId: args.round,
      gameId: args.game,
      kind: args.kind,
      money: { amount: args.amount, currency: args.currency },
      ...(args.reference ? { referenceExternalTransactionId: args.reference } : {}),
    },
  });

const client = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.SQS_ENDPOINT });
const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: process.env.SQS_QUEUE_NAME }));
const sent = await client.send(
  new SendMessageCommand({
    QueueUrl,
    MessageBody: body,
    MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
  }),
);
client.destroy();

console.log(JSON.stringify({ messageId, sqsMessageId: sent.MessageId, messageGroupId: walletId }));

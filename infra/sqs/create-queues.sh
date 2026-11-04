#!/bin/sh
# Creates the wager queues. Safe to re-run: create-queue is a no-op when the
# queue already exists with the same attributes.
set -eu

DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
EVENTS_QUEUE_NAME="wagering-events.fifo"
MAX_RECEIVE_COUNT=5

# The DLQ must exist first: the main queue's RedrivePolicy references its ARN.
dlq_url=$(aws sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

dlq_arn=$(aws sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

redrive_policy="{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVE_COUNT\\\"}"

queue_url=$(aws sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes "{\"FifoQueue\":\"true\",\"RedrivePolicy\":\"$redrive_policy\"}" \
  --query QueueUrl --output text)

# Deduplication uses the eventId sent by the outbox publisher, never the body.
events_url=$(aws sqs create-queue \
  --queue-name "$EVENTS_QUEUE_NAME" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

echo "Events: $events_url"
echo "DLQ:   $dlq_url"
echo "Queue: $queue_url"
aws sqs get-queue-attributes \
  --queue-url "$queue_url" \
  --attribute-names RedrivePolicy \
  --query Attributes.RedrivePolicy --output text

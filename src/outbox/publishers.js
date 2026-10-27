import { SendMessageCommand } from '@aws-sdk/client-sqs';

/** Publishes to SQS. `queueUrls` maps logical destinations (e.g. 'emb-jobs') to queue URLs. */
export function createSqsPublisher({ client, queueUrls }) {
  return {
    async publish(destination, message) {
      const queueUrl = queueUrls[destination];
      if (!queueUrl) throw new Error(`No queue configured for destination ${destination}`);
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            messageType: { DataType: 'String', StringValue: message.messageType },
          },
        }),
      );
    },
  };
}

/** In-memory publisher for tests and local experiments. */
export function createMemoryPublisher({ failFor = new Set() } = {}) {
  const sent = [];
  return {
    sent,
    async publish(destination, message) {
      if (failFor.has(message.messageType))
        throw new Error(`simulated failure for ${message.messageType}`);
      sent.push({ destination, message });
    },
  };
}

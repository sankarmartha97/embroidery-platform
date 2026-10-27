import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

/**
 * SQS consumer loop. A message is deleted only after its handler succeeds. Failures and
 * unknown message types are left on the queue: SQS retries them after the visibility timeout
 * and moves them to the dead-letter queue after maxReceiveCount (set on the queue).
 * Handlers must be idempotent: delivery is at-least-once.
 */
export function createConsumer({
  client,
  queueUrl,
  handlers,
  logger,
  waitSeconds = 20,
  maxMessages = 5,
}) {
  const controller = new AbortController();
  let running = false;

  async function handle(message) {
    let body;
    try {
      body = JSON.parse(message.Body);
    } catch {
      logger.error({ messageId: message.MessageId }, 'unparseable message left for the DLQ');
      return false;
    }
    const handler = handlers[body.messageType];
    const log = logger.child({
      messageId: message.MessageId,
      messageType: body.messageType,
      correlationId: body.payload?.correlationId,
    });
    if (!handler) {
      log.error('no handler for message type; left for the DLQ');
      return false;
    }
    try {
      await handler(body, { log, signal: controller.signal });
      return true;
    } catch (err) {
      log.error({ err }, 'handler failed; message will be retried');
      return false;
    }
  }

  async function pollOnce() {
    const res = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: controller.signal },
    );
    let handled = 0;
    for (const message of res.Messages ?? []) {
      if (await handle(message)) {
        await client.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
        handled += 1;
      }
    }
    return handled;
  }

  return {
    pollOnce,
    async run() {
      running = true;
      while (running) {
        try {
          await pollOnce();
        } catch (err) {
          if (controller.signal.aborted) break;
          logger.error({ err }, 'poll failed; backing off');
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    },
    stop() {
      running = false;
      controller.abort();
    },
  };
}

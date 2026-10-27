// IT-05: a message that keeps failing lands in the dead-letter queue after maxReceiveCount.
// Uses its own short-timeout queues so the test runs in seconds. The alarm on DLQ depth is
// CloudWatch infrastructure (09-devops/monitoring-alerting.md) and is not testable locally.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import pino from 'pino';
import { createConsumer } from '../../workers/consumer.js';

const logger = pino({ level: 'silent' });
const MAX_RECEIVES = 2;

describe('dead-letter queue', () => {
  let sqs;
  let queueUrl;
  let dlqUrl;

  before(async () => {
    sqs = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
    const suffix = Date.now();
    dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `it-dlq-${suffix}` }))).QueueUrl;
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );
    queueUrl = (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `it-jobs-${suffix}`,
          Attributes: {
            VisibilityTimeout: '1',
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: Attributes.QueueArn,
              maxReceiveCount: String(MAX_RECEIVES),
            }),
          },
        }),
      )
    ).QueueUrl;
  });
  after(async () => {
    for (const url of [queueUrl, dlqUrl]) {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
    }
    sqs.destroy();
  });

  it('IT-05: moves a message to the DLQ once it exceeds max receives', async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ messageType: 'job.queued', payload: { jobId: 'poison' } }),
      }),
    );
    let attempts = 0;
    const consumer = createConsumer({
      client: sqs,
      queueUrl,
      logger,
      waitSeconds: 1,
      handlers: {
        'job.queued': async () => {
          attempts += 1;
          throw new Error('always fails');
        },
      },
    });

    let dead = [];
    for (let i = 0; i < 15 && dead.length === 0; i++) {
      await consumer.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, 1100)); // let the visibility timeout pass
      dead =
        (
          await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: dlqUrl,
              WaitTimeSeconds: 0,
              MaxNumberOfMessages: 1,
            }),
          )
        ).Messages ?? [];
    }
    assert.equal(dead.length, 1, 'message is in the DLQ');
    assert.equal(JSON.parse(dead[0].Body).payload.jobId, 'poison');
    assert.equal(attempts, MAX_RECEIVES, 'handled exactly maxReceiveCount times');
  });
});

// Relay → SQS (LocalStack) → consumer: the path every job message will take.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import pino from 'pino';
import { transaction } from '../../src/db/transaction.js';
import { createOutboxRepository } from '../../src/outbox/outbox.repository.js';
import { createSqsPublisher } from '../../src/outbox/publishers.js';
import { createOutboxRelay } from '../../src/outbox/relay.js';
import { createConsumer } from '../../workers/consumer.js';
import { createTestPool, resetDatabase } from '../helpers/db.js';

const logger = pino({ level: 'silent' });
const queueUrl = process.env.SQS_QUEUE_URL_EMB_JOBS;

describe('outbox to SQS to worker', () => {
  let pool;
  let client;
  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    client = new SQSClient({
      region: process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL,
    });
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
  });
  after(async () => {
    client.destroy();
    await pool.end();
  });

  it('delivers an outbox message to its handler and deletes it from the queue', async () => {
    await transaction(pool, (conn) =>
      createOutboxRepository(conn).enqueue({
        aggregateType: 'system',
        aggregateId: '0190f0a0-0000-7000-8000-000000000999',
        messageType: 'system.ping',
        destination: 'emb-jobs',
        payload: { correlationId: 'it-sqs' },
      }),
    );
    const relay = createOutboxRelay({
      pool,
      publisher: createSqsPublisher({ client, queueUrls: { 'emb-jobs': queueUrl } }),
      logger,
    });
    assert.equal((await relay.runOnce()).sent, 1);

    const received = [];
    const consumer = createConsumer({
      client,
      queueUrl,
      logger,
      waitSeconds: 2,
      handlers: { 'system.ping': async (msg) => received.push(msg) },
    });
    let handled = 0;
    for (let i = 0; i < 5 && handled === 0; i++) handled = await consumer.pollOnce();
    assert.equal(handled, 1);
    assert.equal(received[0].payload.correlationId, 'it-sqs');
    assert.equal(await consumer.pollOnce(), 0, 'message was deleted after success');
  });

  it('leaves a message on the queue when its handler fails', async () => {
    const publisher = createSqsPublisher({ client, queueUrls: { 'emb-jobs': queueUrl } });
    await publisher.publish('emb-jobs', { messageType: 'system.ping', payload: {} });
    const consumer = createConsumer({
      client,
      queueUrl,
      logger,
      waitSeconds: 2,
      handlers: {
        'system.ping': async () => {
          throw new Error('boom');
        },
      },
    });
    let handled = -1;
    for (let i = 0; i < 5 && handled <= 0; i++) handled = await consumer.pollOnce();
    assert.equal(handled, 0, 'failed message is not counted as handled (not deleted)');
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
  });
});

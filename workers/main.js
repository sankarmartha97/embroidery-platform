import os from 'node:os';
import { createArtifactStore, createS3Client } from '../src/aws/s3.js';
import { createSqsClient, QUEUE_URLS } from '../src/aws/sqs.js';
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { createSqsPublisher } from '../src/outbox/publishers.js';
import { createOutboxRelay } from '../src/outbox/relay.js';
import { createConsumer } from './consumer.js';
import { FakeEngine } from './engines/fake/fake-engine.js';
import { createHandlers } from './handlers/index.js';
import { createJobRunner } from './job-runner.js';

// The real engine adapter replaces FakeEngine after Gate 1 (ADR-0005).
const engine = new FakeEngine();
const client = createSqsClient();

for (const [name, value] of [
  ['SQS_QUEUE_URL_EMB_JOBS', QUEUE_URLS['emb-jobs']],
  ['S3_BUCKET_ARTIFACTS', env.S3_BUCKET_ARTIFACTS],
]) {
  if (!value) {
    logger.error(`${name} is not set`);
    process.exit(1);
  }
}

const runner = createJobRunner({
  pool,
  engine,
  store: createArtifactStore({ client: createS3Client(), bucket: env.S3_BUCKET_ARTIFACTS }),
  timeoutMs: env.JOB_TIMEOUT_MS,
  heartbeatMs: env.JOB_HEARTBEAT_MS,
  workerId: env.WORKER_ID ?? `${os.hostname()}:${process.pid}`,
});

const relay = createOutboxRelay({
  pool,
  publisher: createSqsPublisher({ client, queueUrls: QUEUE_URLS }),
  logger: logger.child({ component: 'outbox-relay' }),
});
const consumer = createConsumer({
  client,
  queueUrl: QUEUE_URLS['emb-jobs'],
  handlers: createHandlers({ engine, runner }),
  logger: logger.child({ component: 'consumer' }),
});

relay.start();
logger.info({ engine: engine.describe() }, 'worker started');
const done = consumer.run();

async function shutdown(signal) {
  logger.info({ signal }, 'worker shutting down');
  relay.stop();
  consumer.stop();
  await done;
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

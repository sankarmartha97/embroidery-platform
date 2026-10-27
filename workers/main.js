import { createSqsClient, QUEUE_URLS } from '../src/aws/sqs.js';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { createSqsPublisher } from '../src/outbox/publishers.js';
import { createOutboxRelay } from '../src/outbox/relay.js';
import { createConsumer } from './consumer.js';
import { FakeEngine } from './engines/fake/fake-engine.js';
import { createHandlers } from './handlers/index.js';

// The real engine adapter replaces FakeEngine after Gate 1 (ADR-0005).
const engine = new FakeEngine();
const client = createSqsClient();

if (!QUEUE_URLS['emb-jobs']) {
  logger.error('SQS_QUEUE_URL_EMB_JOBS is not set');
  process.exit(1);
}

const relay = createOutboxRelay({
  pool,
  publisher: createSqsPublisher({ client, queueUrls: QUEUE_URLS }),
  logger: logger.child({ component: 'outbox-relay' }),
});
const consumer = createConsumer({
  client,
  queueUrl: QUEUE_URLS['emb-jobs'],
  handlers: createHandlers({ engine }),
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

// IT-01 skeleton: messages enqueued in a transaction are published once by the leader relay.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pino from 'pino';
import { transaction } from '../../src/db/transaction.js';
import { createOutboxRepository } from '../../src/outbox/outbox.repository.js';
import { createMemoryPublisher } from '../../src/outbox/publishers.js';
import { createOutboxRelay } from '../../src/outbox/relay.js';
import { createTestPool, resetDatabase } from '../helpers/db.js';

const logger = pino({ level: 'silent' });
const message = (messageType) => ({
  aggregateType: 'digitizing_job',
  aggregateId: '0190f0a0-0000-7000-8000-000000000123',
  messageType,
  destination: 'emb-jobs',
  payload: { jobId: 'j1', correlationId: 'c1' },
});

describe('outbox relay', () => {
  let pool;
  before(async () => {
    await resetDatabase();
    pool = createTestPool();
  });
  beforeEach(() => pool.query('DELETE FROM outbox_messages'));
  after(() => pool.end());

  it('publishes committed messages and marks them sent', async () => {
    await transaction(pool, (conn) => createOutboxRepository(conn).enqueue(message('job.queued')));
    const publisher = createMemoryPublisher();
    const relay = createOutboxRelay({ pool, publisher, logger });

    assert.deepEqual(await relay.runOnce(), { leader: true, sent: 1, failed: 0 });
    assert.equal(publisher.sent[0].destination, 'emb-jobs');
    assert.equal(publisher.sent[0].message.messageType, 'job.queued');
    assert.deepEqual(publisher.sent[0].message.payload, { jobId: 'j1', correlationId: 'c1' });
    assert.deepEqual(
      await relay.runOnce(),
      { leader: true, sent: 0, failed: 0 },
      'nothing is sent twice',
    );
  });

  it('does not publish messages from a rolled-back transaction', async () => {
    await assert.rejects(
      transaction(pool, async (conn) => {
        await createOutboxRepository(conn).enqueue(message('job.queued'));
        throw new Error('business rule failed');
      }),
    );
    const publisher = createMemoryPublisher();
    await createOutboxRelay({ pool, publisher, logger }).runOnce();
    assert.equal(publisher.sent.length, 0);
  });

  it('records failures and retries them on the next run', async () => {
    await transaction(pool, (conn) => createOutboxRepository(conn).enqueue(message('job.flaky')));
    const failing = createMemoryPublisher({ failFor: new Set(['job.flaky']) });
    assert.deepEqual(await createOutboxRelay({ pool, publisher: failing, logger }).runOnce(), {
      leader: true,
      sent: 0,
      failed: 1,
    });
    const [[row]] = await pool.query('SELECT attempts, last_error, sent_at FROM outbox_messages');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /simulated failure/);
    assert.equal(row.sent_at, null);

    const healthy = createMemoryPublisher();
    assert.equal((await createOutboxRelay({ pool, publisher: healthy, logger }).runOnce()).sent, 1);
  });

  it('only one relay works at a time (leader lock)', async () => {
    await transaction(pool, (conn) => createOutboxRepository(conn).enqueue(message('job.queued')));
    const holder = await pool.getConnection();
    try {
      await holder.query("SELECT GET_LOCK('outbox_relay', 0)");
      const publisher = createMemoryPublisher();
      assert.deepEqual(await createOutboxRelay({ pool, publisher, logger }).runOnce(), {
        leader: false,
        sent: 0,
        failed: 0,
      });
      assert.equal(publisher.sent.length, 0);
    } finally {
      await holder.query("SELECT RELEASE_LOCK('outbox_relay')");
      holder.release();
    }
  });
});

import { createOutboxRepository } from './outbox.repository.js';

/**
 * Publishes unsent outbox rows. Only one relay runs at a time across all tasks: it holds the
 * MySQL named lock `outbox_relay` on its connection while it works (leader lock).
 * Delivery is at-least-once; consumers must be idempotent.
 */
export function createOutboxRelay({
  pool,
  publisher,
  logger,
  batchSize = 50,
  maxAttempts = 10,
  intervalMs = 1000,
  lockName = 'outbox_relay',
}) {
  let timer = null;
  let stopped = true;

  async function runOnce() {
    const conn = await pool.getConnection();
    try {
      const [[{ locked }]] = await conn.query('SELECT GET_LOCK(?, 0) AS locked', [lockName]);
      if (locked !== 1) return { leader: false, sent: 0, failed: 0 };
      try {
        const repo = createOutboxRepository(conn);
        const messages = await repo.listUnsent({ limit: batchSize, maxAttempts });
        let sent = 0;
        let failed = 0;
        for (const message of messages) {
          try {
            await publisher.publish(message.destination, {
              outboxId: message.id,
              messageType: message.messageType,
              aggregateType: message.aggregateType,
              aggregateId: message.aggregateId,
              payload: message.payload,
            });
            await repo.markSent(message.id);
            sent += 1;
          } catch (err) {
            failed += 1;
            await repo.markFailed(message.id, err.message);
            logger.warn({ err, outboxId: message.id }, 'outbox publish failed');
          }
        }
        return { leader: true, sent, failed };
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
      }
    } finally {
      conn.release();
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await runOnce();
      } catch (err) {
        logger.error({ err }, 'outbox relay iteration failed');
      }
      schedule();
    }, intervalMs);
  }

  return {
    runOnce,
    start() {
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

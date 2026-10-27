import { transaction } from '../src/db/transaction.js';
import { closeChildren, createJobsRepository, enqueueJob } from '../src/modules/jobs/index.js';
import { summaryFor } from './job-errors.js';

/**
 * Stuck-job reconciler (S4-03, IT-03). Scheduled task, one instance (09-devops/infrastructure.md);
 * a MySQL named lock makes overlapping runs harmless.
 *
 * A running job whose heartbeat is older than `staleMs`, or that is past its deadline, lost its
 * worker. It goes back to queued with a new queue message (the original message may already be
 * gone), and the next claim increments attempt_count. Once max_attempts are used it fails.
 * Every update is fenced on the attempt number, so a slow-but-alive worker cannot overwrite it.
 */
export function createReconciler({
  pool,
  staleMs,
  logger,
  workerId = 'reconciler',
  lockName = 'reconciler',
}) {
  const CODE = 'ENGINE_TIMEOUT';

  async function reconcileJob({ id, attemptCount, maxAttempts }) {
    return transaction(pool, async (conn) => {
      const jobs = createJobsRepository(conn);
      const message = 'no heartbeat from worker';
      if (attemptCount >= maxAttempts) {
        const final = { status: 'failed', code: CODE, summary: summaryFor(CODE, { final: true }) };
        if (!(await jobs.markFailed(id, attemptCount, { ...final, message, workerId })))
          return null;
        await closeChildren(conn, id, { ...final, workerId });
        return 'failed';
      }
      const requeued = await jobs.requeue(id, attemptCount, {
        code: CODE,
        summary: summaryFor(CODE),
        message,
        workerId,
      });
      if (!requeued) return null;
      await enqueueJob(conn, id, null);
      return 'requeued';
    });
  }

  return {
    /** @returns {Promise<{ leader: boolean, requeued: number, failed: number }>} */
    async runOnce() {
      const conn = await pool.getConnection();
      const result = { leader: false, requeued: 0, failed: 0 };
      try {
        const [[{ locked }]] = await conn.query('SELECT GET_LOCK(?, 0) AS locked', [lockName]);
        if (locked !== 1) return result;
        result.leader = true;
        try {
          for (const stuck of await createJobsRepository(pool).listStuck(staleMs)) {
            const outcome = await reconcileJob(stuck);
            if (outcome) {
              result[outcome] += 1;
              logger.warn(
                { jobId: stuck.id, attempt: stuck.attemptCount, outcome },
                'stuck job reconciled',
              );
            }
          }
        } finally {
          await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
        }
        return result;
      } finally {
        conn.release();
      }
    },
  };
}

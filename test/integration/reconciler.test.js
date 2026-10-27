// S4-03 / IT-03: a worker crashes mid-job → the reconciler requeues it after the deadline,
// attempt_count increments on the next claim, and the job fails after max_attempts.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { createJobsRepository } from '../../src/modules/jobs/index.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { createReconciler } from '../../workers/reconciler.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { insertJob, jobRow, seedVersion } from '../helpers/jobs.js';

const OWNER = '0190f0a0-0000-7000-8000-0000000003c0';
const logger = pino({ level: 'silent' });

describe('reconciler', () => {
  let pool;
  let jobs;
  let reconciler;
  let s3;

  /** Claims the job as a worker that then "crashes" (stops heartbeating). */
  async function crashWorker(jobId, { staleBySeconds = 600 } = {}) {
    const attempt = await jobs.claim(jobId, {
      timeoutMs: 60_000,
      engineVersion: 'x',
      workerId: 'dead',
    });
    assert.ok(attempt, 'claimed');
    await pool.execute(
      `UPDATE digitizing_jobs SET heartbeat_at = CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND WHERE id = ?`,
      [staleBySeconds, jobId],
    );
    return attempt;
  }
  const queuedMessages = async (jobId) =>
    (
      await pool.execute(
        `SELECT COUNT(*) AS n FROM outbox_messages WHERE aggregate_id = ? AND message_type = 'job.queued'`,
        [jobId],
      )
    )[0][0].n;

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, OWNER);
    jobs = createJobsRepository(pool);
    reconciler = createReconciler({ pool, staleMs: 120_000, logger });
    s3 = createS3Client();
  });
  after(async () => {
    s3.destroy();
    await pool.end();
  });

  it('IT-03: requeues a crashed job with a new message; the retry claims attempt 2', async () => {
    const { versionId } = await seedVersion(pool, OWNER);
    const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
    await crashWorker(job.id);

    const result = await reconciler.runOnce();
    assert.deepEqual(result, { leader: true, requeued: 1, failed: 0 });
    let row = await jobRow(pool, job.id);
    assert.equal(row.status, 'queued');
    assert.equal(row.error_code, 'ENGINE_TIMEOUT');
    assert.equal(await queuedMessages(job.id), 1, 'a fresh queue message replaces the lost one');

    const runner = createJobRunner({
      pool,
      engine: new FakeEngine(),
      store: createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS }),
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'alive',
    });
    assert.equal(await runner.run(job.id, { log: logger }), 'succeeded');
    row = await jobRow(pool, job.id);
    assert.equal(row.attempt_count, 2);
    assert.equal(row.status, 'succeeded');
  });

  it('fails the job once max_attempts are used, and closes jobs chained on it', async () => {
    const { versionId } = await seedVersion(pool, OWNER);
    const job = await insertJob(pool, {
      projectVersionId: versionId,
      requestedBy: OWNER,
      maxAttempts: 2,
    });
    const child = await insertJob(pool, {
      projectVersionId: versionId,
      requestedBy: OWNER,
      jobType: 'export',
      targetFormat: 'DST',
      parentJobId: job.id,
    });

    await crashWorker(job.id);
    assert.equal((await reconciler.runOnce()).requeued, 1);
    await crashWorker(job.id);
    assert.deepEqual(await reconciler.runOnce(), { leader: true, requeued: 0, failed: 1 });

    const row = await jobRow(pool, job.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt_count, 2);
    assert.equal(row.error_code, 'ENGINE_TIMEOUT');
    assert.equal(row.error_summary, 'Took too long. Try again later, or simplify the design');
    const childRow = await jobRow(pool, child.id);
    assert.equal(childRow.status, 'failed');
    assert.equal(childRow.error_code, 'ENGINE_TIMEOUT');
  });

  it('leaves healthy running jobs alone but catches one past its deadline', async () => {
    const { versionId } = await seedVersion(pool, OWNER);
    const healthy = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
    await crashWorker(healthy.id, { staleBySeconds: 5 });
    const overdue = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
    await crashWorker(overdue.id, { staleBySeconds: 5 });
    await pool.execute(
      `UPDATE digitizing_jobs SET deadline_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`,
      [overdue.id],
    );

    assert.equal((await reconciler.runOnce()).requeued, 1);
    assert.equal((await jobRow(pool, healthy.id)).status, 'running');
    assert.equal((await jobRow(pool, overdue.id)).status, 'queued');
  });

  it('does nothing while another reconciler holds the lock', async () => {
    const holder = await pool.getConnection();
    try {
      await holder.query(`SELECT GET_LOCK('reconciler', 0)`);
      assert.deepEqual(await reconciler.runOnce(), { leader: false, requeued: 0, failed: 0 });
    } finally {
      await holder.query(`SELECT RELEASE_LOCK('reconciler')`);
      holder.release();
    }
  });
});

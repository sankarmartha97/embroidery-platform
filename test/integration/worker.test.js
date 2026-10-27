// S3-04: worker job loop on real MySQL, LocalStack S3 and SQS.
// Covers IT-02 (duplicate delivery), IT-04 (deterministic error), IT-06 (checksum mismatch),
// IT-11 (cancel queued job), retries, timeouts, lost ownership and the full outbox → SQS path.
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PurgeQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import pino from 'pino';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { sha256 } from '../../src/lib/hash.js';
import { transaction } from '../../src/db/transaction.js';
import { createArtifactsRepository } from '../../src/modules/artifacts/index.js';
import { createJobsRepository } from '../../src/modules/jobs/index.js';
import { createOutboxRepository } from '../../src/outbox/outbox.repository.js';
import { createSqsPublisher } from '../../src/outbox/publishers.js';
import { createOutboxRelay } from '../../src/outbox/relay.js';
import { readMachineFile } from '../../tools/format-harness/index.js';
import { createConsumer, RetryLater } from '../../workers/consumer.js';
import { EngineError, throwIfAborted } from '../../workers/engines/digitizing-engine.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createHandlers } from '../../workers/handlers/index.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { insertJob, jobRow, seedVersion } from '../helpers/jobs.js';

const OWNER = '0190f0a0-0000-7000-8000-00000000c0de';
const PROFILE = { format: 'DST', hoopWidthMm: 100, hoopHeightMm: 100, maxStitchLengthMm: 12.1 };
const logger = pino({ level: 'silent' });

/** FakeEngine whose digitize step waits until aborted (or `ms` elapses). */
class SlowEngine extends FakeEngine {
  constructor(ms = 10_000) {
    super();
    this.ms = ms;
  }
  async generateStitches(document, options) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, this.ms);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    throwIfAborted(options.signal);
    return super.generateStitches(document, options);
  }
}

class FailingEngine extends FakeEngine {
  constructor(error) {
    super();
    this.error = error;
  }
  async generateStitches() {
    throw this.error;
  }
}

describe('worker job loop', () => {
  let pool;
  let store;
  let s3;
  let jobs;
  let artifacts;

  const runnerWith = (overrides = {}) =>
    createJobRunner({
      pool,
      engine: new FakeEngine(),
      store,
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'test-worker',
      ...overrides,
    });
  const run = (runner, jobId) => runner.run(jobId, { log: logger });

  /** Runs a digitize job and returns its stitch_data artifact. */
  async function digitizedVersion() {
    const { versionId } = await seedVersion(pool, OWNER);
    const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
    assert.equal(await run(runnerWith(), job.id), 'succeeded');
    const [stitchData] = await artifacts.listByJob(job.id);
    return { versionId, stitchData };
  }

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, OWNER);
    s3 = createS3Client();
    store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    jobs = createJobsRepository(pool);
    artifacts = createArtifactsRepository(pool);
  });
  after(async () => {
    s3.destroy();
    await pool.end();
  });

  describe('digitize', () => {
    it('claims, digitizes, uploads verified stitch data and succeeds in one go', async () => {
      const { projectId, versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });

      assert.equal(await run(runnerWith(), job.id), 'succeeded');

      const row = await jobRow(pool, job.id);
      assert.equal(row.status, 'succeeded');
      assert.equal(row.progress, 100);
      assert.equal(row.attempt_count, 1);
      assert.equal(row.engine_version, '0.2.0');
      assert.ok(row.started_at && row.finished_at);

      const [artifact] = await artifacts.listByJob(job.id);
      assert.equal(artifact.artifactType, 'stitch_data');
      assert.equal(artifact.formatCode, 'json');
      assert.equal(artifact.engineName, 'fake');
      assert.match(
        artifact.storageKey,
        new RegExp(`^artifacts/${projectId}/${versionId}/[0-9a-f-]{36}\\.json\\.gz$`),
      );

      const stored = await store.get(artifact.storageKey);
      assert.equal(sha256(stored), artifact.sha256);
      assert.equal(stored.length, artifact.fileSizeBytes);
      const stitchData = JSON.parse(gunzipSync(stored));
      assert.equal(stitchData.format, 'emb-stitch-data');
      assert.equal(stitchData.sourceVersionId, versionId);
      assert.equal(artifact.stitchCount, stitchData.stats.stitches);
      assert.ok(artifact.stitchCount > 50, 'curves are followed, not just their end points');
      assert.equal(artifact.colorCount, 2);

      assert.deepEqual(
        (await jobs.listEvents(job.id)).map((e) => `${e.from}→${e.to}#${e.attempt}`),
        ['null→queued#0', 'queued→running#1', 'running→succeeded#1'],
      );
    });

    it('IT-02: a duplicate delivery is skipped; one claim, one set of artifacts', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const runner = runnerWith();
      const outcomes = await Promise.all([run(runner, job.id), run(runner, job.id)]);
      assert.deepEqual(outcomes.sort(), ['duplicate', 'succeeded']);
      assert.equal(await run(runner, job.id), 'duplicate', 'redelivery after success');
      assert.equal((await artifacts.listByJob(job.id)).length, 1);
      assert.equal((await jobRow(pool, job.id)).attempt_count, 1);
    });

    it('IT-04: an invalid document fails at once with a user-safe summary (no retry)', async () => {
      const bad = heartDocument();
      bad.objects[0].stitch.threadId = 'missing';
      const { versionId } = await seedVersion(pool, OWNER, bad);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });

      assert.equal(await run(runnerWith(), job.id), 'failed');
      const row = await jobRow(pool, job.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.attempt_count, 1);
      assert.equal(row.error_code, 'INVALID_DOCUMENT');
      assert.equal(row.error_summary, 'Design has invalid data; fix highlighted objects');
      assert.equal((await artifacts.listByJob(job.id)).length, 0);
    });
  });

  describe('retries', () => {
    it('IT-06: a checksum mismatch stores no artifact and retries; the retry succeeds', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const corrupting = {
        get: store.get,
        put: async (...args) => ({ ...(await store.put(...args)), verified: false }),
      };

      await assert.rejects(run(runnerWith({ store: corrupting }), job.id), (err) => {
        assert.ok(err instanceof RetryLater);
        assert.equal(err.delaySeconds, 30);
        return true;
      });
      let row = await jobRow(pool, job.id);
      assert.equal(row.status, 'queued');
      assert.equal(row.error_code, 'STORAGE_ERROR');
      assert.equal((await artifacts.listByJob(job.id)).length, 0);

      assert.equal(await run(runnerWith(), job.id), 'succeeded');
      row = await jobRow(pool, job.id);
      assert.equal(row.attempt_count, 2);
      assert.equal(row.error_code, null, 'a successful retry clears the last error');
    });

    it('retries a transient engine error up to max_attempts, then fails', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const runner = runnerWith({
        engine: new FailingEngine(new EngineError('ENGINE_UNAVAILABLE', 'vendor down')),
      });
      await assert.rejects(run(runner, job.id), RetryLater);
      await assert.rejects(run(runner, job.id), RetryLater);
      assert.equal(await run(runner, job.id), 'failed');
      const row = await jobRow(pool, job.id);
      assert.equal(row.attempt_count, 3);
      assert.equal(row.error_code, 'ENGINE_UNAVAILABLE');
    });

    it('retries an unexpected error once (ENGINE_INTERNAL) and never echoes its message', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const runner = runnerWith({ engine: new FailingEngine(new Error('secret=hunter2')) });
      await assert.rejects(run(runner, job.id), RetryLater);
      assert.equal(await run(runner, job.id), 'failed');
      const row = await jobRow(pool, job.id);
      assert.equal(row.attempt_count, 2);
      assert.equal(row.error_code, 'ENGINE_INTERNAL');
      const [events] = await pool.execute(
        `SELECT message FROM design_job_events WHERE job_id = ? AND message IS NOT NULL`,
        [job.id],
      );
      assert.ok(events.length > 0);
      for (const e of events) assert.doesNotMatch(e.message, /hunter2/);
    });

    it('turns a timeout into ENGINE_TIMEOUT and requeues the job', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const runner = runnerWith({ engine: new SlowEngine(), timeoutMs: 150 });
      await assert.rejects(run(runner, job.id), RetryLater);
      const row = await jobRow(pool, job.id);
      assert.equal(row.status, 'queued');
      assert.equal(row.error_code, 'ENGINE_TIMEOUT');
    });
  });

  describe('cancellation and ownership', () => {
    it('IT-11: a job cancelled while queued is never claimed', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      await jobs.requestCancel(job.id);

      assert.equal(await run(runnerWith(), job.id), 'cancelled');
      const row = await jobRow(pool, job.id);
      assert.equal(row.status, 'cancelled');
      assert.equal(row.attempt_count, 0);
      assert.equal(row.started_at, null);
    });

    it('stops a running job when cancellation is requested (seen on heartbeat)', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const outcome = run(runnerWith({ engine: new SlowEngine() }), job.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await jobs.requestCancel(job.id);

      assert.equal(await outcome, 'cancelled');
      const row = await jobRow(pool, job.id);
      assert.equal(row.status, 'cancelled');
      assert.equal(row.error_code, 'CANCELLED');
      assert.equal((await artifacts.listByJob(job.id)).length, 0);
    });

    it('discards the work of a worker that lost the job (fenced on attempt)', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, { projectVersionId: versionId, requestedBy: OWNER });
      const outcome = run(runnerWith({ engine: new SlowEngine() }), job.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // What the reconciler (S4-03) will do with a stuck job.
      await pool.execute(`UPDATE digitizing_jobs SET status = 'queued' WHERE id = ?`, [job.id]);

      assert.equal(await outcome, 'lost');
      assert.equal((await jobRow(pool, job.id)).status, 'queued');
      assert.equal((await artifacts.listByJob(job.id)).length, 0);
    });
  });

  describe('jobs that read stitch data', () => {
    it('exports a DST machine file from the stitch data artifact', async () => {
      const { versionId, stitchData } = await digitizedVersion();
      const job = await insertJob(pool, {
        projectVersionId: versionId,
        requestedBy: OWNER,
        jobType: 'export',
        inputArtifactId: stitchData.id,
        targetFormat: 'DST',
        machineProfile: PROFILE,
      });
      assert.equal(await run(runnerWith(), job.id), 'succeeded');

      const [file] = await artifacts.listByJob(job.id);
      assert.equal(file.artifactType, 'machine_file');
      assert.equal(file.formatCode, 'DST');
      assert.match(file.storageKey, /\.dst$/);
      assert.equal(file.stitchCount, stitchData.stitchCount);

      const summary = readMachineFile(await store.get(file.storageKey), 'dst');
      assert.deepEqual(summary.warnings, []);
      assert.equal(summary.colorChanges, 1);
      assert.ok(summary.stitches >= stitchData.stitchCount);
    });

    it('validates stitch data against the job machine profile', async () => {
      const { versionId, stitchData } = await digitizedVersion();
      const job = await insertJob(pool, {
        projectVersionId: versionId,
        requestedBy: OWNER,
        jobType: 'validate',
        inputArtifactId: stitchData.id,
        machineProfile: PROFILE,
      });
      assert.equal(await run(runnerWith(), job.id), 'succeeded');
      const [report] = await artifacts.listByJob(job.id);
      assert.equal(report.artifactType, 'report');
      assert.equal(report.validationStatus, 'passed');
      assert.deepEqual(JSON.parse(await store.get(report.storageKey)), {
        status: 'passed',
        issues: [],
      });
    });

    it('refuses stitch data that belongs to another version', async () => {
      const { stitchData } = await digitizedVersion();
      const other = await seedVersion(pool, OWNER);
      const job = await insertJob(pool, {
        projectVersionId: other.versionId,
        requestedBy: OWNER,
        jobType: 'export',
        inputArtifactId: stitchData.id,
        targetFormat: 'DST',
      });
      assert.equal(await run(runnerWith(), job.id), 'failed');
      assert.equal((await jobRow(pool, job.id)).error_code, 'INVALID_DOCUMENT');
    });

    it('fails a simulate job the FakeEngine cannot render, without retrying', async () => {
      const { versionId, stitchData } = await digitizedVersion();
      const job = await insertJob(pool, {
        projectVersionId: versionId,
        requestedBy: OWNER,
        jobType: 'simulate',
        inputArtifactId: stitchData.id,
      });
      assert.equal(await run(runnerWith(), job.id), 'failed');
      const row = await jobRow(pool, job.id);
      assert.equal(row.error_code, 'UNSUPPORTED_STITCH_TYPE');
      assert.equal(row.attempt_count, 1);
    });
  });

  describe('full path', () => {
    const queueUrl = process.env.SQS_QUEUE_URL_EMB_JOBS;
    let sqs;
    beforeEach(async () => {
      sqs = new SQSClient({
        region: process.env.AWS_REGION,
        endpoint: process.env.AWS_ENDPOINT_URL,
      });
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
    });

    it('runs a job enqueued through the outbox: relay → SQS → consumer → runner → S3', async () => {
      const { versionId } = await seedVersion(pool, OWNER);
      const jobId = await transaction(pool, async (conn) => {
        const job = await insertJob(conn, { projectVersionId: versionId, requestedBy: OWNER });
        await createOutboxRepository(conn).enqueue({
          aggregateType: 'digitizing_job',
          aggregateId: job.id,
          messageType: 'job.queued',
          destination: 'emb-jobs',
          payload: { jobId: job.id, correlationId: 'it-full-path' },
        });
        return job.id;
      });

      const relay = createOutboxRelay({
        pool,
        publisher: createSqsPublisher({ client: sqs, queueUrls: { 'emb-jobs': queueUrl } }),
        logger,
      });
      assert.equal((await relay.runOnce()).sent, 1);

      const engine = new FakeEngine();
      const consumer = createConsumer({
        client: sqs,
        queueUrl,
        logger,
        waitSeconds: 2,
        handlers: createHandlers({ engine, runner: runnerWith({ engine }) }),
      });
      let handled = 0;
      for (let i = 0; i < 5 && handled === 0; i++) handled = await consumer.pollOnce();
      assert.equal(handled, 1);
      assert.equal((await jobRow(pool, jobId)).status, 'succeeded');
      assert.equal((await artifacts.listByJob(jobId)).length, 1);
      assert.equal(await consumer.pollOnce(), 0, 'message deleted after success');
      sqs.destroy();
    });
  });
});

// S4-02: jobs API end to end (HTTP → MySQL → worker runner → LocalStack S3).
// Covers IT-01 (job + outbox in one transaction), IT-07, IT-08, IT-11 and IT-12.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { createMemoryPublisher } from '../../src/outbox/publishers.js';
import { createOutboxRelay } from '../../src/outbox/relay.js';
import { EngineError, throwIfAborted } from '../../workers/engines/digitizing-engine.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const OWNER = '0190f0a0-0000-7000-8000-0000000004d1';
const EDITOR = '0190f0a0-0000-7000-8000-0000000004e1';
const VIEWER = '0190f0a0-0000-7000-8000-0000000004f1';
const STRANGER = '0190f0a0-0000-7000-8000-0000000004aa';
const PLAIN_EDITOR = '0190f0a0-0000-7000-8000-0000000004cc'; // collaborator without designer role
const JANOME = '00000000-0000-7000-8000-000000000104';
const logger = pino({ level: 'silent' });

describe('jobs API', () => {
  let pool;
  let server;
  let auth;
  let s3;
  let store;
  let keySeq = 0;

  async function call(user, method, path, { body, key, headers = {} } = {}) {
    const res = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await auth.sign(user)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  }
  const newKey = () => `key-${++keySeq}`;
  const createJob = (user, projectId, body, key = newKey()) =>
    call(user, 'POST', `/design-projects/${projectId}/jobs`, { body, key });

  /** A project (owned by OWNER) with one snapshot version of the heart document. */
  async function projectWithVersion(body = { title: 'Jobs' }) {
    const project = (await call(OWNER, 'POST', '/design-projects', { body })).body;
    await call(OWNER, 'PUT', `/design-projects/${project.id}/draft`, {
      body: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    const version = (await call(OWNER, 'POST', `/design-projects/${project.id}/versions`)).body;
    return { projectId: project.id, versionId: version.id };
  }

  const runnerWith = (engine = new FakeEngine()) =>
    createJobRunner({ pool, engine, store, timeoutMs: 30_000, heartbeatMs: 50, workerId: 'it' });
  const runJob = (jobId, engine) => runnerWith(engine).run(jobId, { log: logger });

  async function outboxRows(jobId) {
    const [rows] = await pool.execute(
      `SELECT message_type, sent_at FROM outbox_messages WHERE aggregate_id = ?`,
      [jobId],
    );
    return rows;
  }
  const countJobs = async () =>
    (await pool.query('SELECT COUNT(*) AS n FROM digitizing_jobs'))[0][0].n;

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, OWNER, EDITOR, VIEWER, STRANGER, PLAIN_EDITOR);
    auth = await createAuthKit();
    s3 = createS3Client();
    store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles: {
        [OWNER]: ['designer'],
        [EDITOR]: ['designer'],
        [VIEWER]: ['designer'],
        [STRANGER]: ['designer'],
      },
    });
  });
  after(async () => {
    await server.close();
    s3.destroy();
    await pool.end();
  });

  describe('create', () => {
    it('IT-01: commits the job and exactly one queue message together; the relay sends it once', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const res = await createJob(OWNER, projectId, { jobType: 'digitize', versionId });
      assert.equal(res.status, 202);
      assert.equal(res.headers.get('location'), `/api/v1/digitizing-jobs/${res.body.id}`);
      assert.equal(res.body.status, 'queued');
      assert.equal(res.body.engineName, 'fake');
      assert.equal(res.body.attemptCount, 0);
      assert.equal(res.body.error, null);
      assert.deepEqual(res.body.outputArtifactIds, []);

      // "Process killed before the relay runs": the message is already durable in the outbox.
      const rows = await outboxRows(res.body.id);
      assert.deepEqual(
        rows.map((r) => [r.message_type, r.sent_at]),
        [['job.queued', null]],
      );
      const publisher = createMemoryPublisher();
      const relay = createOutboxRelay({ pool, publisher, logger });
      await relay.runOnce();
      await relay.runOnce();
      const forJob = publisher.sent.filter((m) => m.message.payload.jobId === res.body.id);
      assert.equal(forJob.length, 1);
      assert.equal(forJob[0].destination, 'emb-jobs');
    });

    it('requires an Idempotency-Key (400)', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const res = await call(OWNER, 'POST', `/design-projects/${projectId}/jobs`, {
        body: { jobType: 'digitize', versionId },
      });
      assert.equal(res.status, 400);
    });

    it('replays the same key and body as the same job, without a second message', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const key = newKey();
      const first = await createJob(OWNER, projectId, { jobType: 'digitize', versionId }, key);
      const again = await createJob(OWNER, projectId, { jobType: 'digitize', versionId }, key);
      assert.equal(again.status, 202);
      assert.equal(again.body.id, first.body.id);
      assert.equal((await outboxRows(first.body.id)).length, 1);
    });

    it('IT-12: the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const key = newKey();
      await createJob(OWNER, projectId, { jobType: 'digitize', versionId }, key);
      const before = await countJobs();
      const reused = await createJob(
        OWNER,
        projectId,
        { jobType: 'digitize', versionId, settings: { quality: 'draft' } },
        key,
      );
      assert.equal(reused.status, 409);
      assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(await countJobs(), before);
    });

    it('scopes keys per user', async () => {
      const { projectId, versionId } = await projectWithVersion();
      await pool.execute(
        `INSERT INTO design_collaborators (id, project_id, user_id, role, invited_by)
         VALUES (UUID(), ?, ?, 'editor', ?)`,
        [projectId, EDITOR, OWNER],
      );
      const key = newKey();
      const mine = await createJob(OWNER, projectId, { jobType: 'digitize', versionId }, key);
      const theirs = await createJob(EDITOR, projectId, { jobType: 'digitize', versionId }, key);
      assert.equal(theirs.status, 202);
      assert.notEqual(theirs.body.id, mine.body.id);
    });

    it('turns two concurrent requests with one key into one job', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const key = newKey();
      const before = await countJobs();
      const results = await Promise.all(
        [1, 2, 3].map(() => createJob(OWNER, projectId, { jobType: 'digitize', versionId }, key)),
      );
      assert.deepEqual(
        results.map((r) => r.status),
        [202, 202, 202],
      );
      assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
      assert.equal(await countJobs(), before + 1);
    });

    it('snapshots the machine profile and keeps free-form settings', async () => {
      const { projectId, versionId } = await projectWithVersion({
        title: 'With profile',
        machineProfileId: JANOME,
      });
      const res = await createJob(OWNER, projectId, {
        jobType: 'digitize',
        versionId,
        settings: { quality: 'draft', nested: { a: 1 } },
      });
      assert.equal(res.status, 202);
      const [[row]] = await pool.execute(
        `SELECT machine_profile_id, machine_profile_json, settings_json FROM digitizing_jobs WHERE id = ?`,
        [res.body.id],
      );
      assert.equal(row.machine_profile_id, JANOME);
      assert.equal(row.machine_profile_json.hoopWidthMm, 140);
      assert.equal(row.machine_profile_json.format, 'JEF');
      assert.deepEqual(row.settings_json, { quality: 'draft', nested: { a: 1 } });
    });

    it('rejects invalid combinations with 422', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const other = await projectWithVersion();
      const cases = [
        [
          { jobType: 'export', versionId, digitizeIfMissing: true },
          '/targetFormat',
          'VALIDATION_FAILED',
        ],
        [
          { jobType: 'export', versionId, targetFormat: 'XYZ', digitizeIfMissing: true },
          '/targetFormat',
          'UNSUPPORTED_FORMAT',
        ],
        [
          { jobType: 'digitize', versionId, targetFormat: 'DST' },
          '/targetFormat',
          'VALIDATION_FAILED',
        ],
        [
          { jobType: 'digitize', versionId, inputArtifactId: versionId },
          '/inputArtifactId',
          'VALIDATION_FAILED',
        ],
        [{ jobType: 'digitize', versionId: other.versionId }, '/versionId', 'VALIDATION_FAILED'],
        [
          { jobType: 'validate', versionId, inputArtifactId: versionId },
          '/inputArtifactId',
          'VALIDATION_FAILED',
        ],
        [
          { jobType: 'digitize', versionId, machineProfileId: other.versionId },
          '/machineProfileId',
          'VALIDATION_FAILED',
        ],
        [{ jobType: 'render', versionId }, '/jobType', 'VALIDATION_FAILED'],
      ];
      for (const [body, path, code] of cases) {
        const res = await createJob(OWNER, projectId, body);
        assert.equal(res.status, 422, JSON.stringify(body));
        assert.equal(res.body.error.code, code, JSON.stringify(body));
        assert.equal(res.body.error.details[0].path, path, JSON.stringify(body));
      }
    });
  });

  describe('stitch data and chaining', () => {
    it('IT-07: export without stitch data and digitizeIfMissing=false is 409 STITCH_DATA_REQUIRED', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const res = await createJob(OWNER, projectId, {
        jobType: 'export',
        versionId,
        targetFormat: 'DST',
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'STITCH_DATA_REQUIRED');
    });

    it('IT-08: digitizeIfMissing chains a digitize job, and the export uses its stitch data', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const res = await createJob(OWNER, projectId, {
        jobType: 'export',
        versionId,
        targetFormat: 'DST',
        digitizeIfMissing: true,
      });
      assert.equal(res.status, 202);
      const exportJob = res.body;
      assert.ok(exportJob.parentJobId);
      assert.equal(exportJob.inputArtifactId, null);
      assert.equal((await outboxRows(exportJob.id)).length, 0, 'export waits: no message yet');
      assert.equal((await outboxRows(exportJob.parentJobId)).length, 1);

      const parent = await call(OWNER, 'GET', `/digitizing-jobs/${exportJob.parentJobId}`);
      assert.equal(parent.body.jobType, 'digitize');
      assert.equal(parent.body.projectVersionId, versionId);

      assert.equal(await runJob(exportJob.parentJobId), 'succeeded');
      const digitized = await call(OWNER, 'GET', `/digitizing-jobs/${exportJob.parentJobId}`);
      const [stitchDataId] = digitized.body.outputArtifactIds;
      const released = await call(OWNER, 'GET', `/digitizing-jobs/${exportJob.id}`);
      assert.equal(released.body.inputArtifactId, stitchDataId);
      assert.equal((await outboxRows(exportJob.id)).length, 1, 'released export is queued');

      assert.equal(await runJob(exportJob.id), 'succeeded');
      const done = await call(OWNER, 'GET', `/digitizing-jobs/${exportJob.id}`);
      assert.equal(done.body.status, 'succeeded');
      assert.equal(done.body.progress, 100);
      assert.equal(done.body.outputArtifactIds.length, 1);
      const [[file]] = await pool.execute(
        `SELECT artifact_type, format_code FROM design_artifacts WHERE id = ?`,
        [done.body.outputArtifactIds[0]],
      );
      assert.deepEqual({ ...file }, { artifact_type: 'machine_file', format_code: 'DST' });
    });

    it('uses existing stitch data instead of chaining when there is some', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const digitize = await createJob(OWNER, projectId, { jobType: 'digitize', versionId });
      await runJob(digitize.body.id);
      const [stitchDataId] = (await call(OWNER, 'GET', `/digitizing-jobs/${digitize.body.id}`)).body
        .outputArtifactIds;

      const res = await createJob(OWNER, projectId, {
        jobType: 'validate',
        versionId,
        digitizeIfMissing: true,
        machineProfileId: JANOME,
      });
      assert.equal(res.body.parentJobId, null);
      assert.equal(res.body.inputArtifactId, stitchDataId);
      assert.equal(await runJob(res.body.id), 'succeeded');
    });

    it('fails a chained job with its parent’s error when the parent fails', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const res = await createJob(OWNER, projectId, {
        jobType: 'export',
        versionId,
        targetFormat: 'JEF',
        digitizeIfMissing: true,
      });
      class Unsupported extends FakeEngine {
        async generateStitches() {
          throw new EngineError('UNSUPPORTED_STITCH_TYPE', 'satin not supported');
        }
      }
      assert.equal(await runJob(res.body.parentJobId, new Unsupported()), 'failed');
      const child = await call(OWNER, 'GET', `/digitizing-jobs/${res.body.id}`);
      assert.equal(child.body.status, 'failed');
      assert.deepEqual(child.body.error, {
        code: 'UNSUPPORTED_STITCH_TYPE',
        summary: "This stitch type isn't supported yet",
      });
      assert.equal((await outboxRows(res.body.id)).length, 0);
    });
  });

  describe('get and cancel', () => {
    it('IT-11: cancelling a queued job ends it at once and the worker skips it', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const job = (await createJob(OWNER, projectId, { jobType: 'digitize', versionId })).body;
      const cancelled = await call(OWNER, 'POST', `/digitizing-jobs/${job.id}/cancel`);
      assert.equal(cancelled.status, 202);
      assert.equal(cancelled.body.status, 'cancelled');
      assert.deepEqual(cancelled.body.error, { code: 'CANCELLED', summary: 'Cancelled by user' });

      assert.equal(await runJob(job.id), 'duplicate', 'message delivered after cancel is skipped');
      assert.equal((await call(OWNER, 'GET', `/digitizing-jobs/${job.id}`)).body.attemptCount, 0);

      const again = await call(OWNER, 'POST', `/digitizing-jobs/${job.id}/cancel`);
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'INVALID_STATE');
    });

    it('cancelling a queued parent also cancels the job waiting on it', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const child = (
        await createJob(OWNER, projectId, {
          jobType: 'export',
          versionId,
          targetFormat: 'DST',
          digitizeIfMissing: true,
        })
      ).body;
      await call(OWNER, 'POST', `/digitizing-jobs/${child.parentJobId}/cancel`);
      const after = await call(OWNER, 'GET', `/digitizing-jobs/${child.id}`);
      assert.equal(after.body.status, 'cancelled');
    });

    it('asks a running job to stop; the worker cancels it at the next heartbeat', async () => {
      const { projectId, versionId } = await projectWithVersion();
      const job = (await createJob(OWNER, projectId, { jobType: 'digitize', versionId })).body;
      class Slow extends FakeEngine {
        async generateStitches(doc, options) {
          await new Promise((resolve) => options.signal.addEventListener('abort', resolve));
          throwIfAborted(options.signal);
        }
      }
      const outcome = runJob(job.id, new Slow());
      for (let i = 0; i < 50; i++) {
        if ((await call(OWNER, 'GET', `/digitizing-jobs/${job.id}`)).body.status === 'running')
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const requested = await call(OWNER, 'POST', `/digitizing-jobs/${job.id}/cancel`);
      assert.equal(requested.status, 202);
      assert.equal(requested.body.status, 'running', 'best effort: still running when we answer');
      assert.equal(await outcome, 'cancelled');
      assert.equal(
        (await call(OWNER, 'GET', `/digitizing-jobs/${job.id}`)).body.status,
        'cancelled',
      );
    });
  });

  describe('authorization', () => {
    let projectId;
    let versionId;
    let jobId;

    before(async () => {
      ({ projectId, versionId } = await projectWithVersion());
      jobId = (await createJob(OWNER, projectId, { jobType: 'digitize', versionId })).body.id;
      for (const [user, role] of [
        [EDITOR, 'editor'],
        [VIEWER, 'viewer'],
        [PLAIN_EDITOR, 'editor'],
      ]) {
        await pool.execute(
          `INSERT INTO design_collaborators (id, project_id, user_id, role, invited_by)
           VALUES (UUID(), ?, ?, ?, ?)`,
          [projectId, user, role, OWNER],
        );
      }
    });

    it('hides jobs and projects from strangers (404)', async () => {
      assert.equal(
        (await createJob(STRANGER, projectId, { jobType: 'digitize', versionId })).status,
        404,
      );
      assert.equal((await call(STRANGER, 'GET', `/digitizing-jobs/${jobId}`)).status, 404);
      assert.equal((await call(STRANGER, 'POST', `/digitizing-jobs/${jobId}/cancel`)).status, 404);
      assert.equal((await call(STRANGER, 'GET', '/digitizing-jobs/not-a-uuid')).status, 404);
    });

    it('lets viewers read jobs but not create or cancel them', async () => {
      assert.equal((await call(VIEWER, 'GET', `/digitizing-jobs/${jobId}`)).status, 200);
      assert.equal(
        (await createJob(VIEWER, projectId, { jobType: 'digitize', versionId })).status,
        403,
      );
      assert.equal((await call(VIEWER, 'POST', `/digitizing-jobs/${jobId}/cancel`)).status, 403);
    });

    it('needs the designer role to digitize and can_export to export', async () => {
      assert.equal(
        (await createJob(PLAIN_EDITOR, projectId, { jobType: 'digitize', versionId })).status,
        403,
      );
      assert.equal(
        (await createJob(EDITOR, projectId, { jobType: 'digitize', versionId })).status,
        202,
      );
      const exportBody = {
        jobType: 'export',
        versionId,
        targetFormat: 'DST',
        digitizeIfMissing: true,
      };
      assert.equal((await createJob(EDITOR, projectId, exportBody)).status, 403);
      await pool.execute(
        `UPDATE design_collaborators SET can_export = TRUE WHERE project_id = ? AND user_id = ?`,
        [projectId, EDITOR],
      );
      assert.equal((await createJob(EDITOR, projectId, exportBody)).status, 202);
    });

    it('lets an editor cancel someone else’s job', async () => {
      const job = (await createJob(OWNER, projectId, { jobType: 'digitize', versionId })).body;
      assert.equal((await call(EDITOR, 'POST', `/digitizing-jobs/${job.id}/cancel`)).status, 202);
    });
  });
});

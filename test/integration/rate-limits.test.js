// S6-06 / SEC-T09: tighter rate limits on job creation and download URLs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const ALICE = '0190f0a0-0000-7000-8000-0000000007a1';
const BOB = '0190f0a0-0000-7000-8000-0000000007b0';

describe('SEC-T09 rate limits', () => {
  let pool;
  let server;
  let auth;
  let s3;
  let projectId;
  let versionId;
  let artifactId;
  let keySeq = 0;

  async function call(user, method, path, { body, headers = {} } = {}) {
    const res = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await auth.sign(user)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  }
  const createJob = (user = ALICE) =>
    call(user, 'POST', `/design-projects/${projectId}/jobs`, {
      body: { jobType: 'digitize', versionId },
      headers: { 'Idempotency-Key': `rl-${++keySeq}` },
    });
  const download = (user = ALICE) => call(user, 'POST', `/artifacts/${artifactId}/download-url`);

  async function setup(user) {
    const project = (await call(user, 'POST', '/design-projects', { body: { title: 'RL' } })).body;
    await call(user, 'PUT', `/design-projects/${project.id}/draft`, {
      body: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    const version = (await call(user, 'POST', `/design-projects/${project.id}/versions`)).body;
    return { projectId: project.id, versionId: version.id };
  }

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, ALICE, BOB);
    auth = await createAuthKit();
    s3 = createS3Client();
    const store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    const roles = { [ALICE]: ['designer'], [BOB]: ['designer'] };

    // Fixture built with generous limits, then the app restarts with tight ones.
    server = await startApp({ db: pool, verifyToken: auth.verifyToken, roles, store });
    ({ projectId, versionId } = await setup(ALICE));
    const job = (await createJob()).body;
    await createJobRunner({
      pool,
      engine: new FakeEngine(),
      store,
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'it',
    }).run(job.id, { log: pino({ level: 'silent' }) });
    artifactId = (await call(ALICE, 'GET', `/digitizing-jobs/${job.id}`)).body.outputArtifactIds[0];
    await server.close();

    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles,
      store,
      rateLimit: { windowMs: 60_000, max: 1000, jobsMax: 2, downloadsMax: 2 },
    });
  });
  after(async () => {
    await server.close();
    s3.destroy();
    await pool.end();
  });

  it('limits job creation per user with 429 RATE_LIMITED and Retry-After', async () => {
    assert.equal((await createJob()).status, 202);
    const second = await createJob();
    assert.equal(second.status, 202);
    assert.equal(second.headers.get('ratelimit-limit'), '2');
    assert.equal(second.headers.get('ratelimit-remaining'), '0');

    const limited = await createJob();
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 60);
  });

  it('limits download URLs separately from jobs', async () => {
    assert.equal((await download()).status, 200, 'job bucket is used up; download bucket is not');
    assert.equal((await download()).status, 200);
    const limited = await download();
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
  });

  it('leaves other endpoints and other users unaffected', async () => {
    assert.equal((await call(ALICE, 'GET', `/design-projects/${projectId}`)).status, 200);
    const bob = await setup(BOB);
    const res = await call(BOB, 'POST', `/design-projects/${bob.projectId}/jobs`, {
      body: { jobType: 'digitize', versionId: bob.versionId },
      headers: { 'Idempotency-Key': 'bob-1' },
    });
    assert.equal(res.status, 202);
  });
});

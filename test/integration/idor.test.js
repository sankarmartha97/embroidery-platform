// S5-11: IDOR matrix. SEC-T01 (user B gets 404 for every route with user A's id),
// SEC-T02 (lists never include others' private projects), SEC-T05 (revoked collaborator loses
// access immediately). The matrix is checked against openapi.yaml, so a new id route without a
// row here fails the suite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import YAML from 'yaml';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const ALICE = '0190f0a0-0000-7000-8000-0000000006a1';
const BOB = '0190f0a0-0000-7000-8000-0000000006b0';
const CAROL = '0190f0a0-0000-7000-8000-0000000006c0';

// Contract routes with an id that are not built yet (they 404 for everyone today).
const NOT_IMPLEMENTED = new Set([
  'POST /design-projects/{id}/duplicate',
  'POST /design-projects/{id}/rights',
  'POST /design-projects/{id}/submit',
  'POST /design-publications/{id}/review',
  'POST /artifacts/{artifactId}/stitch-outcomes',
]);

describe('IDOR matrix', () => {
  let pool;
  let server;
  let auth;
  let s3;
  let ids;

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
    return { status: res.status, body: await res.text() };
  }

  /** Every route with an id: [contract route, actual request]. */
  const matrix = () => [
    ['GET /design-projects/{id}', 'GET', `/design-projects/${ids.project}`],
    [
      'PATCH /design-projects/{id}',
      'PATCH',
      `/design-projects/${ids.project}`,
      { body: { title: 'x' } },
    ],
    [
      'PUT /design-projects/{id}/draft',
      'PUT',
      `/design-projects/${ids.project}/draft`,
      { body: heartDocument(), headers: { 'If-Match': '"1"' } },
    ],
    ['POST /design-projects/{id}/versions', 'POST', `/design-projects/${ids.project}/versions`],
    ['GET /design-projects/{id}/versions', 'GET', `/design-projects/${ids.project}/versions`],
    [
      'POST /design-projects/{id}/jobs',
      'POST',
      `/design-projects/${ids.project}/jobs`,
      {
        body: { jobType: 'digitize', versionId: ids.version },
        headers: { 'Idempotency-Key': `idor-${Math.random()}` },
      },
    ],
    ['GET /design-projects/{id}/artifacts', 'GET', `/design-projects/${ids.project}/artifacts`],
    ['GET /digitizing-jobs/{jobId}', 'GET', `/digitizing-jobs/${ids.job}`],
    ['POST /digitizing-jobs/{jobId}/cancel', 'POST', `/digitizing-jobs/${ids.queuedJob}/cancel`],
    [
      'POST /artifacts/{artifactId}/download-url',
      'POST',
      `/artifacts/${ids.artifact}/download-url`,
    ],
    ['GET /artifacts/{artifactId}/stitch-data', 'GET', `/artifacts/${ids.artifact}/stitch-data`],
    ['GET /artifacts/{artifactId}/report', 'GET', `/artifacts/${ids.report}/report`],
  ];

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, ALICE, BOB, CAROL);
    auth = await createAuthKit();
    s3 = createS3Client();
    const store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    const designers = { [ALICE]: ['designer'], [BOB]: ['designer'], [CAROL]: ['designer'] };
    server = await startApp({ db: pool, verifyToken: auth.verifyToken, roles: designers, store });

    // Alice's private project with a version, a finished digitize job and a queued job.
    const project = JSON.parse(
      (await call(ALICE, 'POST', '/design-projects', { body: { title: 'Mine' } })).body,
    );
    await call(ALICE, 'PUT', `/design-projects/${project.id}/draft`, {
      body: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    const version = JSON.parse(
      (await call(ALICE, 'POST', `/design-projects/${project.id}/versions`)).body,
    );
    const createJob = async (key) =>
      JSON.parse(
        (
          await call(ALICE, 'POST', `/design-projects/${project.id}/jobs`, {
            body: { jobType: 'digitize', versionId: version.id },
            headers: { 'Idempotency-Key': key },
          })
        ).body,
      );
    const job = await createJob('done');
    const runner = createJobRunner({
      pool,
      engine: new FakeEngine(),
      store,
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'it',
    });
    await runner.run(job.id, { log: pino({ level: 'silent' }) });
    const finished = JSON.parse((await call(ALICE, 'GET', `/digitizing-jobs/${job.id}`)).body);
    const validate = JSON.parse(
      (
        await call(ALICE, 'POST', `/design-projects/${project.id}/jobs`, {
          body: {
            jobType: 'validate',
            versionId: version.id,
            inputArtifactId: finished.outputArtifactIds[0],
            machineProfileId: '00000000-0000-7000-8000-000000000101',
          },
          headers: { 'Idempotency-Key': 'validate' },
        })
      ).body,
    );
    await runner.run(validate.id, { log: pino({ level: 'silent' }) });
    const validated = JSON.parse(
      (await call(ALICE, 'GET', `/digitizing-jobs/${validate.id}`)).body,
    );
    const queuedJob = await createJob('queued');
    ids = {
      project: project.id,
      version: version.id,
      job: job.id,
      queuedJob: queuedJob.id,
      artifact: finished.outputArtifactIds[0],
      report: validated.outputArtifactIds[0],
    };
    // Bob has his own project, so his lists are not trivially empty.
    await call(BOB, 'POST', '/design-projects', { body: { title: 'Bob’s' } });
  });
  after(async () => {
    await server.close();
    s3.destroy();
    await pool.end();
  });

  it('covers every id route in the API contract', () => {
    const openapi = YAML.parse(readFileSync('contracts/openapi.yaml', 'utf8'));
    const contractRoutes = Object.entries(openapi.paths)
      .filter(([path]) => path.includes('{'))
      .flatMap(([path, ops]) =>
        Object.keys(ops)
          .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
          .map((m) => `${m.toUpperCase()} ${path}`),
      );
    const covered = new Set(matrix().map(([route]) => route));
    const missing = contractRoutes.filter((r) => !covered.has(r) && !NOT_IMPLEMENTED.has(r));
    assert.deepEqual(missing, [], 'add these routes to the IDOR matrix');
  });

  it('SEC-T01: another user gets 404 on every route with someone else’s id', async () => {
    for (const [route, method, path, options] of matrix()) {
      const res = await call(BOB, method, path, options);
      assert.equal(res.status, 404, `${route} → ${res.status} ${res.body.slice(0, 120)}`);
      assert.match(res.body, /"code":"NOT_FOUND"/, route);
    }
  });

  it('SEC-T01: the owner is not blocked by the same requests (the matrix is meaningful)', async () => {
    for (const [route, method, path, options] of matrix()) {
      if (route.startsWith('PUT') || route.includes('/cancel')) continue; // state-changing on purpose
      const res = await call(ALICE, method, path, options);
      assert.ok(res.status < 400, `${route} → ${res.status} ${res.body.slice(0, 120)}`);
    }
  });

  it('SEC-T02: list endpoints never include others’ private projects', async () => {
    for (const scope of ['all', 'owned', 'shared']) {
      const res = await call(BOB, 'GET', `/design-projects?scope=${scope}&limit=100`);
      assert.equal(res.status, 200);
      assert.equal(res.body.includes(ids.project), false, `scope=${scope}`);
    }
  });

  it('SEC-T05: a revoked collaborator loses access immediately', async () => {
    await pool.execute(
      `INSERT INTO design_collaborators (id, project_id, user_id, role, invited_by)
       VALUES (UUID(), ?, ?, 'editor', ?)`,
      [ids.project, CAROL, ALICE],
    );
    assert.equal((await call(CAROL, 'GET', `/design-projects/${ids.project}`)).status, 200);
    assert.ok((await call(CAROL, 'GET', '/design-projects')).body.includes(ids.project));

    await pool.execute(
      `UPDATE design_collaborators SET revoked_at = CURRENT_TIMESTAMP(3) WHERE project_id = ? AND user_id = ?`,
      [ids.project, CAROL],
    );
    for (const [route, method, path, options] of matrix()) {
      const res = await call(CAROL, method, path, options);
      assert.equal(res.status, 404, `${route} after revoke → ${res.status}`);
    }
    assert.equal((await call(CAROL, 'GET', '/design-projects')).body.includes(ids.project), false);
  });
});

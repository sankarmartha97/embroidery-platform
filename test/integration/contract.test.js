// S6-05: contract tests. Every implemented endpoint's success response (and the error envelope)
// is checked against contracts/openapi.yaml, and every implemented route must be exercised.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { startApp } from '../helpers/app.js';
import { contractErrors, openapi } from '../helpers/contract.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const USER = '0190f0a0-0000-7000-8000-0000000008a1';
const NOT_IMPLEMENTED = new Set([
  'POST /design-projects/{id}/rights',
  'POST /design-projects/{id}/submit',
  'POST /design-publications/{id}/review',
  'POST /artifacts/{artifactId}/stitch-outcomes',
]);

describe('API contract', () => {
  let pool;
  let server;
  let auth;
  let s3;
  let store;
  const checked = new Set();

  /** Calls the API and checks the body against the contract for (method, route, status). */
  async function expectContract(route, method, path, status, { body, headers = {} } = {}) {
    const res = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await auth.sign(USER)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    assert.equal(res.status, status, `${method} ${route}: ${JSON.stringify(json).slice(0, 200)}`);
    assert.deepEqual(
      contractErrors(method, route, status, json),
      [],
      `${method} ${route} ${status}`,
    );
    if (status < 400) checked.add(`${method} ${route}`);
    return json;
  }

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, USER);
    auth = await createAuthKit();
    s3 = createS3Client();
    store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles: { [USER]: ['designer'] },
      store,
    });
  });
  after(async () => {
    await server.close();
    s3.destroy();
    await pool.end();
  });

  it('reference endpoints match MachineFormat and MachineProfile', async () => {
    const formats = await expectContract('/machine-formats', 'GET', '/machine-formats', 200);
    assert.ok(formats.data.length > 0);
    const profiles = await expectContract('/machine-profiles', 'GET', '/machine-profiles', 200);
    assert.ok(profiles.data.length >= 5, 'seeded system presets');
  });

  it('"My Machine" endpoints match UserMachine', async () => {
    await expectContract('/me/machines', 'POST', '/me/machines', 201, {
      body: {
        machineBrand: 'Brother',
        machineModel: 'SE1900',
        preferredFormat: 'PES',
        hoops: [{ name: '5x7', widthMm: 130, heightMm: 180 }],
      },
    });
    await expectContract('/me/machines', 'GET', '/me/machines', 200);
  });

  it('projects, versions, jobs and artifacts match their schemas end to end', async () => {
    const project = await expectContract('/design-projects', 'POST', '/design-projects', 201, {
      body: { title: 'Contract', machineProfileId: '00000000-0000-7000-8000-000000000101' },
    });
    const id = project.id;
    await expectContract('/design-projects', 'GET', '/design-projects', 200);
    await expectContract('/design-projects/{id}', 'GET', `/design-projects/${id}`, 200);
    await expectContract('/design-projects/{id}', 'PATCH', `/design-projects/${id}`, 200, {
      body: { description: 'checked against openapi.yaml' },
    });
    await expectContract(
      '/design-projects/{id}/draft',
      'PUT',
      `/design-projects/${id}/draft`,
      200,
      {
        body: heartDocument(),
        headers: { 'If-Match': '"0"' },
      },
    );
    const version = await expectContract(
      '/design-projects/{id}/versions',
      'POST',
      `/design-projects/${id}/versions`,
      201,
      { body: { label: 'v1' } },
    );
    await expectContract(
      '/design-projects/{id}/versions',
      'POST',
      `/design-projects/${id}/versions`,
      200,
    );
    await expectContract(
      '/design-projects/{id}/versions',
      'GET',
      `/design-projects/${id}/versions`,
      200,
    );

    await expectContract(
      '/design-projects/{id}/duplicate',
      'POST',
      `/design-projects/${id}/duplicate`,
      201,
      { body: { versionId: version.id, title: 'Contract copy' } },
    );

    const exportJob = await expectContract(
      '/design-projects/{id}/jobs',
      'POST',
      `/design-projects/${id}/jobs`,
      202,
      {
        body: {
          jobType: 'export',
          versionId: version.id,
          targetFormat: 'DST',
          digitizeIfMissing: true,
        },
        headers: { 'Idempotency-Key': 'contract-export' },
      },
    );
    const runner = createJobRunner({
      pool,
      engine: new FakeEngine(),
      store,
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'it',
    });
    const silent = { log: pino({ level: 'silent' }) };
    await runner.run(exportJob.parentJobId, silent);
    await runner.run(exportJob.id, silent);
    const done = await expectContract(
      '/digitizing-jobs/{jobId}',
      'GET',
      `/digitizing-jobs/${exportJob.id}`,
      200,
    );
    assert.equal(done.status, 'succeeded');

    const queued = await expectContract(
      '/design-projects/{id}/jobs',
      'POST',
      `/design-projects/${id}/jobs`,
      202,
      {
        body: { jobType: 'digitize', versionId: version.id },
        headers: { 'Idempotency-Key': 'contract-cancel' },
      },
    );
    await expectContract(
      '/digitizing-jobs/{jobId}/cancel',
      'POST',
      `/digitizing-jobs/${queued.id}/cancel`,
      202,
    );

    const { data } = await expectContract(
      '/design-projects/{id}/artifacts',
      'GET',
      `/design-projects/${id}/artifacts`,
      200,
    );
    const stitchData = data.find((a) => a.artifactType === 'stitch_data');
    await expectContract(
      '/artifacts/{artifactId}/download-url',
      'POST',
      `/artifacts/${done.outputArtifactIds[0]}/download-url`,
      200,
    );
    await expectContract(
      '/artifacts/{artifactId}/stitch-data',
      'GET',
      `/artifacts/${stitchData.id}/stitch-data`,
      200,
    );

    const validateJob = await expectContract(
      '/design-projects/{id}/jobs',
      'POST',
      `/design-projects/${id}/jobs`,
      202,
      {
        body: { jobType: 'validate', versionId: version.id, inputArtifactId: stitchData.id },
        headers: { 'Idempotency-Key': 'contract-validate' },
      },
    );
    await runner.run(validateJob.id, silent);
    const validated = await expectContract(
      '/digitizing-jobs/{jobId}',
      'GET',
      `/digitizing-jobs/${validateJob.id}`,
      200,
    );
    await expectContract(
      '/artifacts/{artifactId}/report',
      'GET',
      `/artifacts/${validated.outputArtifactIds[0]}/report`,
      200,
    );
  });

  it('errors match the error envelope', async () => {
    await expectContract(
      '/design-projects/{id}',
      'GET',
      '/design-projects/0190f0a0-0000-7000-8000-0000000fffff',
      404,
    );
    const project = await expectContract('/design-projects', 'POST', '/design-projects', 201, {
      body: { title: 'Errors' },
    });
    await expectContract(
      '/design-projects/{id}/draft',
      'PUT',
      `/design-projects/${project.id}/draft`,
      409,
      {
        body: heartDocument(),
        headers: { 'If-Match': '"5"' },
      },
    );
    await expectContract(
      '/design-projects/{id}/draft',
      'PUT',
      `/design-projects/${project.id}/draft`,
      422,
      {
        body: { ...heartDocument(), units: 'in' },
        headers: { 'If-Match': '"0"' },
      },
    );
  });

  it('exercised every implemented route in the contract', () => {
    const implemented = Object.entries(openapi.paths).flatMap(([route, ops]) =>
      Object.keys(ops)
        .filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
        .map((m) => `${m.toUpperCase()} ${route}`)
        .filter((r) => !NOT_IMPLEMENTED.has(r)),
    );
    assert.deepEqual(
      implemented.filter((r) => !checked.has(r)),
      [],
      'routes without a contract check',
    );
  });
});

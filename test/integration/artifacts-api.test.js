// S5-03/04/05/06: artifact listing, signed downloads with export events, the simulator's
// stitch-data fetch and audit events. Covers SEC-T03, SEC-T04 and SEC-T10 (downloads).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pino from 'pino';
import { createArtifactStore, createS3Client } from '../../src/aws/s3.js';
import { sha256 } from '../../src/lib/hash.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import { createJobRunner } from '../../workers/job-runner.js';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const OWNER = '0190f0a0-0000-7000-8000-0000000005d1';
const VIEWER = '0190f0a0-0000-7000-8000-0000000005f1';
const EXPORTER = '0190f0a0-0000-7000-8000-0000000005e1';
const STRANGER = '0190f0a0-0000-7000-8000-0000000005aa';
const BUYER = '0190f0a0-0000-7000-8000-0000000005b1';
const BROWSER = '0190f0a0-0000-7000-8000-0000000005b2'; // customer without a purchase
const MODERATOR = '0190f0a0-0000-7000-8000-0000000005ad';
const silent = pino({ level: 'silent' });

describe('artifacts API', () => {
  let pool;
  let auth;
  let s3;
  let store;
  let server;
  let logLines;
  let keySeq = 0;
  // Fixture: a published project (v1) with stitch data + DST, and an unpublished v2 export.
  let projectId;
  let v1;
  let stitchData;
  let machineFile;
  let laterMachineFile;

  async function call(user, method, path, { body, headers = {}, base = server } = {}) {
    const res = await fetch(`${base.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await auth.sign(user)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  const download = (user, artifactId, base) =>
    call(user, 'POST', `/artifacts/${artifactId}/download-url`, { base });

  async function lastEvent(artifactId, userId) {
    const [[row]] = await pool.execute(
      `SELECT decision, basis, reason_code, entitlement_ref, url_expires_at, client_ip_hash,
              user_agent, correlation_id
         FROM design_export_events WHERE artifact_id = ? AND user_id = ?
        ORDER BY id DESC LIMIT 1`,
      [artifactId, userId],
    );
    return row;
  }

  /** Snapshot the current draft, then digitize + export it to DST through the jobs API. */
  async function exportVersion(document) {
    const { draftRevision } = (await call(OWNER, 'GET', `/design-projects/${projectId}`)).body;
    await call(OWNER, 'PUT', `/design-projects/${projectId}/draft`, {
      body: document,
      headers: { 'If-Match': `"${draftRevision}"` },
    });
    const version = (await call(OWNER, 'POST', `/design-projects/${projectId}/versions`)).body;
    const job = (
      await call(OWNER, 'POST', `/design-projects/${projectId}/jobs`, {
        body: {
          jobType: 'export',
          versionId: version.id,
          targetFormat: 'DST',
          digitizeIfMissing: true,
        },
        headers: { 'Idempotency-Key': `k-${++keySeq}` },
      })
    ).body;
    const runner = createJobRunner({
      pool,
      engine: new FakeEngine(),
      store,
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'it',
    });
    assert.equal(await runner.run(job.parentJobId, { log: silent }), 'succeeded');
    assert.equal(await runner.run(job.id, { log: silent }), 'succeeded');
    const list = (
      await call(OWNER, 'GET', `/design-projects/${projectId}/artifacts?versionId=${version.id}`)
    ).body.data;
    return {
      version,
      stitchData: list.find((a) => a.artifactType === 'stitch_data'),
      machineFile: list.find((a) => a.artifactType === 'machine_file'),
    };
  }

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, OWNER, VIEWER, EXPORTER, STRANGER, BUYER, BROWSER, MODERATOR);
    auth = await createAuthKit();
    s3 = createS3Client();
    store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    logLines = [];
    const logger = pino({ level: 'info' }, { write: (line) => logLines.push(line) });

    // Created first so the entitlement stub can name the project.
    const boot = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles: { [OWNER]: ['designer'] },
      store,
    });
    server = boot;
    projectId = (
      await call(OWNER, 'POST', '/design-projects', { body: { title: 'Heart Patch ♥' } })
    ).body.id;
    ({ version: v1, stitchData, machineFile } = await exportVersion(heartDocument()));
    ({ machineFile: laterMachineFile } = await exportVersion(
      heartDocument({ canvas: { width: 120, height: 120 } }),
    ));
    await boot.close();

    await pool.execute(
      `UPDATE design_projects SET status = 'published', visibility = 'marketplace' WHERE id = ?`,
      [projectId],
    );
    await pool.execute(
      `INSERT INTO design_publications
         (id, project_id, project_version_id, submitted_by, status, marketplace_listing_ref, decided_at)
       VALUES (UUID(), ?, ?, ?, 'approved', 'listing-42', CURRENT_TIMESTAMP(3))`,
      [projectId, v1.id, OWNER],
    );
    for (const [user, role, canExport] of [
      [VIEWER, 'viewer', false],
      [EXPORTER, 'editor', true],
    ]) {
      await pool.execute(
        `INSERT INTO design_collaborators (id, project_id, user_id, role, can_export, invited_by)
         VALUES (UUID(), ?, ?, ?, ?, ?)`,
        [projectId, user, role, canExport, OWNER],
      );
    }
    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles: { [OWNER]: ['designer'], [MODERATOR]: ['staff.moderator'] },
      store,
      logger,
      entitlements: { [BUYER]: [{ projectId, basis: 'purchase', ref: 'order-77' }] },
    });
  });
  after(async () => {
    await server.close();
    s3.destroy();
    await pool.end();
  });

  describe('list', () => {
    it('lists artifacts for readers, filtered by version and type, without storage keys', async () => {
      const all = await call(VIEWER, 'GET', `/design-projects/${projectId}/artifacts`);
      assert.equal(all.status, 200);
      assert.equal(all.body.data.length, 4);
      for (const a of all.body.data) assert.equal('storageKey' in a, false);

      const files = await call(
        OWNER,
        'GET',
        `/design-projects/${projectId}/artifacts?type=machine_file&versionId=${v1.id}`,
      );
      assert.deepEqual(
        files.body.data.map((a) => a.id),
        [machineFile.id],
      );
      assert.equal(files.body.data[0].formatCode, 'DST');
      assert.ok(files.body.data[0].stitchCount > 0);
    });

    it('rejects bad filters and hides the list from non-readers', async () => {
      assert.equal(
        (await call(OWNER, 'GET', `/design-projects/${projectId}/artifacts?type=x`)).status,
        422,
      );
      assert.equal(
        (await call(OWNER, 'GET', `/design-projects/${projectId}/artifacts?versionId=1`)).status,
        422,
      );
      assert.equal(
        (await call(STRANGER, 'GET', `/design-projects/${projectId}/artifacts`)).status,
        404,
      );
      assert.equal(
        (await call(BUYER, 'GET', `/design-projects/${projectId}/artifacts`)).status,
        404,
      );
    });
  });

  describe('download URL', () => {
    it('gives the owner a ≤ 5-minute signed URL to the exact file, and records it', async () => {
      const res = await call(OWNER, 'POST', `/artifacts/${machineFile.id}/download-url`, {
        headers: { 'User-Agent': 'it-agent/1.0' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.body.sha256, machineFile.sha256);
      const ttl = (Date.parse(res.body.expiresAt) - Date.now()) / 1000;
      assert.ok(ttl > 290 && ttl <= 300, `ttl ${ttl}`);
      assert.equal(new URL(res.body.url).searchParams.get('X-Amz-Expires'), '300');

      const file = await fetch(res.body.url);
      assert.equal(file.status, 200);
      assert.equal(sha256(Buffer.from(await file.arrayBuffer())), machineFile.sha256);
      assert.equal(
        file.headers.get('content-disposition'),
        `attachment; filename="heart-patch-v${v1.versionNumber}.dst"`,
      );

      const event = await lastEvent(machineFile.id, OWNER);
      assert.equal(event.decision, 'allowed');
      assert.equal(event.basis, 'owner');
      assert.ok(event.url_expires_at);
      assert.match(event.client_ip_hash, /^[0-9a-f]{64}$/);
      assert.equal(event.user_agent, 'it-agent/1.0');
      assert.ok(event.correlation_id);
    });

    it('needs the export permission for collaborators to download machine files', async () => {
      const denied = await download(VIEWER, machineFile.id);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.code, 'FORBIDDEN');
      const event = await lastEvent(machineFile.id, VIEWER);
      assert.equal(event.decision, 'denied');
      assert.equal(event.basis, 'collaborator');
      assert.equal(event.reason_code, 'EXPORT_NOT_ALLOWED');
      assert.equal(
        (await download(VIEWER, stitchData.id)).status,
        200,
        'viewers may fetch stitch data',
      );
      assert.equal((await download(EXPORTER, machineFile.id)).status, 200);
      assert.equal((await lastEvent(machineFile.id, EXPORTER)).basis, 'collaborator');
    });

    it('lets staff download, recorded with basis staff', async () => {
      assert.equal((await download(MODERATOR, machineFile.id)).status, 200);
      assert.equal((await lastEvent(machineFile.id, MODERATOR)).basis, 'staff');
    });

    it('SEC-T03: a customer without an entitlement gets 403 ENTITLEMENT_REQUIRED, recorded', async () => {
      const res = await download(BROWSER, machineFile.id);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'ENTITLEMENT_REQUIRED');
      const event = await lastEvent(machineFile.id, BROWSER);
      assert.equal(event.decision, 'denied');
      assert.equal(event.basis, 'none');
      assert.equal(event.reason_code, 'ENTITLEMENT_REQUIRED');
    });

    it('lets an entitled buyer download the published version, with the entitlement recorded', async () => {
      const res = await download(BUYER, machineFile.id);
      assert.equal(res.status, 200);
      const event = await lastEvent(machineFile.id, BUYER);
      assert.equal(event.basis, 'purchase');
      assert.equal(event.entitlement_ref, 'order-77');
    });

    it('hides what a buyer is not entitled to see (404), and records the denial', async () => {
      for (const artifact of [stitchData, laterMachineFile]) {
        assert.equal((await download(BUYER, artifact.id)).status, 404);
        const event = await lastEvent(artifact.id, BUYER);
        assert.equal(event.decision, 'denied');
        assert.equal(event.reason_code, 'NOT_VISIBLE');
      }
    });

    it('answers 404 for unknown ids without recording anything', async () => {
      assert.equal((await download(OWNER, '0190f0a0-0000-7000-8000-00000000ffff')).status, 404);
      assert.equal((await download(OWNER, 'nope')).status, 404);
    });

    it('SEC-T04: S3 rejects the signed URL once it expires', async () => {
      const shortLived = await startApp({
        db: pool,
        verifyToken: auth.verifyToken,
        store,
        downloadTtlSeconds: 1,
      });
      try {
        const res = await download(OWNER, machineFile.id, shortLived);
        assert.equal((await fetch(res.body.url)).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal((await fetch(res.body.url)).status, 403);
      } finally {
        await shortLived.close();
      }
    });

    it('SEC-T10: never writes signed URLs to the logs', async () => {
      await download(OWNER, machineFile.id);
      const all = logLines.join('');
      assert.ok(logLines.length > 0, 'logs were captured');
      assert.doesNotMatch(all, /X-Amz-Signature|X-Amz-Credential/);
    });
  });

  describe('stitch data for the simulator', () => {
    it('serves gzip JSON with a content-hash ETag to project readers', async () => {
      const res = await fetch(`${server.url}/api/v1/artifacts/${stitchData.id}/stitch-data`, {
        headers: { Authorization: `Bearer ${await auth.sign(VIEWER)}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-encoding'), 'gzip');
      assert.equal(res.headers.get('etag'), `"${stitchData.sha256}"`);
      const data = await res.json(); // fetch decompresses
      assert.equal(data.format, 'emb-stitch-data');
      assert.equal(data.sourceVersionId, v1.id);

      const cached = await fetch(`${server.url}/api/v1/artifacts/${stitchData.id}/stitch-data`, {
        headers: {
          Authorization: `Bearer ${await auth.sign(VIEWER)}`,
          'If-None-Match': `"${stitchData.sha256}"`,
        },
      });
      assert.equal(cached.status, 304);
    });

    it('is not a download (no export event) and is hidden from non-readers', async () => {
      const [[{ n }]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM design_export_events WHERE artifact_id = ? AND user_id = ?`,
        [stitchData.id, OWNER],
      );
      await call(OWNER, 'GET', `/artifacts/${stitchData.id}/stitch-data`);
      const [[after]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM design_export_events WHERE artifact_id = ? AND user_id = ?`,
        [stitchData.id, OWNER],
      );
      assert.equal(after.n, n);
      assert.equal(
        (await call(BUYER, 'GET', `/artifacts/${stitchData.id}/stitch-data`)).status,
        404,
      );
      assert.equal(
        (await call(STRANGER, 'GET', `/artifacts/${stitchData.id}/stitch-data`)).status,
        404,
      );
      assert.equal(
        (await call(OWNER, 'GET', `/artifacts/${machineFile.id}/stitch-data`)).status,
        404,
      );
    });
  });

  describe('audit', () => {
    const auditLines = () => logLines.map((l) => JSON.parse(l)).filter((l) => l.audit === true);

    it('audits staff access to other users’ projects, but not owners', async () => {
      const before = auditLines().length;
      await call(OWNER, 'GET', `/design-projects/${projectId}`);
      assert.equal(auditLines().length, before, 'owner access is not audited');

      await call(MODERATOR, 'GET', `/design-projects/${projectId}`);
      const [line] = auditLines().slice(before);
      assert.equal(line.auditType, 'staff.project_access');
      assert.equal(line.actorId, MODERATOR);
      assert.equal(line.projectId, projectId);
      assert.equal(line.ownerUserId, OWNER);
      assert.ok(line.correlationId);
    });
  });
});

// S9-01: rights declarations, submission and moderation on real MySQL, with real jobs (FakeEngine)
// for the "passing export" rule. FR-17, FR-18, SEC-T11 (designers cannot review or verify rights).
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

const DESIGNER = '0190f0a0-0000-7000-8000-000000000e01';
const EDITOR = '0190f0a0-0000-7000-8000-000000000e02';
const STRANGER = '0190f0a0-0000-7000-8000-000000000e03';
const MODERATOR = '0190f0a0-0000-7000-8000-000000000e04';
const RIGHTS_ADMIN = '0190f0a0-0000-7000-8000-000000000e05';
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';

describe('rights, submission and moderation', () => {
  let pool;
  let server;
  let auth;
  let s3;
  let runner;
  let project;
  let version;
  let publication;

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
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** Queues a job and runs it to the end with FakeEngine, like the worker does. */
  async function runJob(body) {
    const queued = await call(DESIGNER, 'POST', `/design-projects/${project.id}/jobs`, {
      body: { versionId: version.id, ...body },
      headers: { 'Idempotency-Key': `pub-${Math.random()}` },
    });
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    const ids = [queued.body.parentJobId, queued.body.id].filter(Boolean);
    for (const id of ids) await runner.run(id, { log: pino({ level: 'silent' }) });
    return (await call(DESIGNER, 'GET', `/digitizing-jobs/${queued.body.id}`)).body;
  }

  const submit = (user = DESIGNER, body = { versionId: version.id, acceptCreatorTerms: true }) =>
    call(user, 'POST', `/design-projects/${project.id}/submit`, { body });
  const declare = (body, user = DESIGNER) =>
    call(user, 'POST', `/design-projects/${project.id}/rights`, { body });
  const review = (body, user = MODERATOR) =>
    call(user, 'POST', `/design-publications/${publication.id}/review`, { body });
  const projectStatus = async () =>
    (await call(DESIGNER, 'GET', `/design-projects/${project.id}`)).body;

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, DESIGNER, EDITOR, STRANGER, MODERATOR, RIGHTS_ADMIN);
    auth = await createAuthKit();
    s3 = createS3Client();
    const store = createArtifactStore({ client: s3, bucket: process.env.S3_BUCKET_ARTIFACTS });
    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      store,
      roles: {
        [DESIGNER]: ['designer'],
        [EDITOR]: ['designer'],
        [STRANGER]: ['designer'],
        [MODERATOR]: ['staff.moderator'],
        [RIGHTS_ADMIN]: ['staff.rights_admin'],
      },
    });
    runner = createJobRunner({
      pool,
      engine: new FakeEngine(),
      store,
      timeoutMs: 30_000,
      heartbeatMs: 50,
      workerId: 'it',
    });
    project = (
      await call(DESIGNER, 'POST', '/design-projects', {
        body: { title: 'Heart for sale', machineProfileId: TAJIMA_100 },
      })
    ).body;
    await call(DESIGNER, 'PUT', `/design-projects/${project.id}/draft`, {
      body: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    version = (await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`)).body;
    await pool.execute(
      `INSERT INTO design_collaborators (id, project_id, user_id, role, can_export, invited_by)
       VALUES (UUID(), ?, ?, 'editor', TRUE, ?)`,
      [project.id, EDITOR, DESIGNER],
    );
  });
  after(async () => {
    await server.close();
    s3.destroy();
    await pool.end();
  });

  describe('rights declarations', () => {
    it('needs a holder and source for licensed artwork', async () => {
      const res = await declare({ rightsType: 'licensed' });
      assert.equal(res.status, 422);
      assert.deepEqual(
        res.body.error.details.map((d) => d.path),
        ['/rightsHolderName', '/sourceReference'],
      );
      const asset = await declare({
        rightsType: 'owned',
        assetId: '0190f0a0-0000-7000-8000-00000000aaaa',
      });
      assert.equal(asset.status, 422);
      assert.equal(asset.body.error.details[0].path, '/assetId');
    });

    it('lets only the owner declare, and project readers list', async () => {
      assert.equal((await declare({ rightsType: 'owned' }, EDITOR)).status, 403);
      assert.equal((await declare({ rightsType: 'owned' }, STRANGER)).status, 404);
      const res = await declare({ rightsType: 'owned', commercialUseAllowed: true });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.assetId, null);
      assert.equal(res.body.verificationStatus, 'declared');
      assert.equal(res.body.declaredBy, DESIGNER);
      assert.equal(res.body.commercialUseAllowed, true);
      assert.equal(res.body.modificationAllowed, false);

      const list = await call(EDITOR, 'GET', `/design-projects/${project.id}/rights`);
      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 1);
      assert.equal(
        (await call(STRANGER, 'GET', `/design-projects/${project.id}/rights`)).status,
        404,
      );
    });

    it('SEC-T11: only staff.rights_admin verifies rights, and it counts for submission', async () => {
      const [rights] = (await call(DESIGNER, 'GET', `/design-projects/${project.id}/rights`)).body
        .data;
      const path = `/design-rights/${rights.id}/verification`;
      for (const user of [DESIGNER, MODERATOR]) {
        assert.equal(
          (await call(user, 'POST', path, { body: { status: 'verified' } })).status,
          403,
        );
      }
      const rejected = await call(RIGHTS_ADMIN, 'POST', path, { body: { status: 'rejected' } });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.verificationStatus, 'rejected');
      assert.equal(rejected.body.verifiedBy, RIGHTS_ADMIN);

      // A rejected declaration does not count.
      const blocked = await submit();
      assert.equal(blocked.status, 422);
      assert.equal(blocked.body.error.code, 'RIGHTS_DECLARATION_REQUIRED');

      const verified = await call(RIGHTS_ADMIN, 'POST', path, { body: { status: 'verified' } });
      assert.equal(verified.body.verificationStatus, 'verified');
      assert.equal(
        (
          await call(RIGHTS_ADMIN, 'POST', '/design-rights/not-a-uuid/verification', {
            body: { status: 'verified' },
          })
        ).status,
        404,
      );
    });
  });

  describe('submission', () => {
    it('FR-17: needs a passing export of the version', async () => {
      const res = await submit();
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'PASSING_EXPORT_REQUIRED');

      const exported = await runJob({
        jobType: 'export',
        targetFormat: 'DST',
        digitizeIfMissing: true,
      });
      assert.equal(exported.status, 'succeeded');
      // An export alone is not enough: the stitch data must have been validated.
      assert.equal((await submit()).body.error.code, 'PASSING_EXPORT_REQUIRED');
      const validated = await runJob({
        jobType: 'validate',
        digitizeIfMissing: true,
        machineProfileId: TAJIMA_100,
      });
      assert.equal(validated.status, 'succeeded');
    });

    it('checks the version, the terms and who submits', async () => {
      assert.equal(
        (await submit(DESIGNER, { versionId: version.id, acceptCreatorTerms: false })).status,
        422,
      );
      const other = (await call(DESIGNER, 'POST', '/design-projects', { body: { title: 'x' } }))
        .body;
      await call(DESIGNER, 'PUT', `/design-projects/${other.id}/draft`, {
        body: heartDocument(),
        headers: { 'If-Match': '"0"' },
      });
      const foreign = (await call(DESIGNER, 'POST', `/design-projects/${other.id}/versions`)).body;
      const res = await submit(DESIGNER, { versionId: foreign.id, acceptCreatorTerms: true });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.details[0].path, '/versionId');
      assert.equal((await submit(EDITOR)).status, 403);
      assert.equal((await submit(STRANGER)).status, 404);
    });

    it('submits: the project goes in review and the creator terms are recorded', async () => {
      const res = await submit();
      assert.equal(res.status, 201, JSON.stringify(res.body));
      publication = res.body;
      assert.equal(publication.status, 'submitted');
      assert.equal(publication.projectVersionId, version.id);
      assert.equal(publication.submittedBy, DESIGNER);
      assert.equal(publication.decidedAt, null);
      assert.equal((await projectStatus()).status, 'in_review');

      const [[terms]] = await pool.execute(
        `SELECT entitlement_type, license_terms_version, client_ip_hash
           FROM design_license_acceptances WHERE project_id = ?`,
        [project.id],
      );
      assert.equal(terms.entitlement_type, 'creator_terms');
      assert.ok(terms.license_terms_version);
      assert.match(terms.client_ip_hash, /^[0-9a-f]{64}$/);

      assert.equal((await submit()).status, 409);
      assert.equal((await declare({ rightsType: 'owned' })).status, 409);
    });
  });

  describe('moderation', () => {
    it('SEC-T11: designers cannot see the queue or review', async () => {
      assert.equal((await call(DESIGNER, 'GET', '/design-publications')).status, 403);
      assert.equal((await review({ decision: 'approve' }, DESIGNER)).status, 403);
      assert.equal((await review({ decision: 'approve' }, RIGHTS_ADMIN)).status, 403);
    });

    it('lists the submission in the queue with what the moderator needs', async () => {
      const res = await call(MODERATOR, 'GET', '/design-publications');
      assert.equal(res.status, 200);
      const item = res.body.data.find((p) => p.id === publication.id);
      assert.equal(item.project.title, 'Heart for sale');
      assert.equal(item.project.ownerUserId, DESIGNER);
      assert.equal(item.versionNumber, version.versionNumber);
      assert.equal(item.validationStatus, 'warning');
      assert.equal(item.rights[0].verificationStatus, 'verified');
      assert.deepEqual(
        (await call(MODERATOR, 'GET', '/design-publications?status=approved')).body.data,
        [],
      );
      assert.equal((await call(MODERATOR, 'GET', '/design-publications?status=x')).status, 422);
    });

    it('requires a reason to request changes, and returns the project to draft', async () => {
      assert.equal((await review({ decision: 'request_changes' })).status, 422);
      const res = await review({ decision: 'request_changes', reason: 'Add a description.' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'changes_requested');
      assert.equal(res.body.reviewerUserId, MODERATOR);
      assert.equal(res.body.decisionReason, 'Add a description.');
      assert.ok(res.body.decidedAt);
      assert.equal((await projectStatus()).status, 'draft');
      assert.equal((await review({ decision: 'approve' })).status, 409);
    });

    it('FR-18: approval publishes the exact submitted version', async () => {
      publication = (await submit()).body;
      const res = await review({ decision: 'approve' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'approved');
      const detail = await projectStatus();
      assert.equal(detail.status, 'published');
      assert.equal(detail.visibility, 'marketplace');

      const history = await call(EDITOR, 'GET', `/design-projects/${project.id}/publications`);
      assert.deepEqual(
        history.body.data.map((p) => p.status),
        ['approved', 'changes_requested'],
      );
      const owner = await call(DESIGNER, 'GET', `/design-publications/${publication.id}`);
      assert.equal(owner.status, 200);
      assert.equal(owner.body.projectVersionId, version.id);
      assert.equal(
        (await call(STRANGER, 'GET', `/design-publications/${publication.id}`)).status,
        404,
      );
      assert.equal((await submit()).status, 409);
    });
  });
});

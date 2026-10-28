// S3-03 / S3-07: projects, draft autosave and versions end to end on real MySQL.
// Includes IT-09 (stale If-Match) and IT-10 (identical snapshot returns the same version).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const DESIGNER = '0190f0a0-0000-7000-8000-0000000000d1';
const EDITOR = '0190f0a0-0000-7000-8000-0000000000e1';
const VIEWER = '0190f0a0-0000-7000-8000-0000000000f1';
const STRANGER = '0190f0a0-0000-7000-8000-0000000000aa';
const CUSTOMER = '0190f0a0-0000-7000-8000-0000000000cc';
const MODERATOR = '0190f0a0-0000-7000-8000-0000000000ad';
const BROTHER_5X7 = '00000000-0000-7000-8000-000000000103';

describe('projects API', () => {
  let pool;
  let server;
  let auth;

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

  const createProject = async (user = DESIGNER, body = { title: 'Heart' }) => {
    const res = await call(user, 'POST', '/design-projects', { body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const saveDraft = (user, id, revision, document) =>
    call(user, 'PUT', `/design-projects/${id}/draft`, {
      body: document,
      headers: { 'If-Match': `"${revision}"` },
    });
  const addCollaborator = (projectId, userId, role, canExport = false) =>
    pool.execute(
      `INSERT INTO design_collaborators (id, project_id, user_id, role, can_export, invited_by)
       VALUES (UUID(), ?, ?, ?, ?, ?)`,
      [projectId, userId, role, canExport, DESIGNER],
    );

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, DESIGNER, EDITOR, VIEWER, STRANGER, CUSTOMER, MODERATOR);
    auth = await createAuthKit();
    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles: {
        [DESIGNER]: ['designer'],
        [EDITOR]: ['designer'],
        [VIEWER]: ['designer'],
        [STRANGER]: ['designer'],
        [MODERATOR]: ['staff.moderator'],
      },
    });
  });
  after(async () => {
    await server.close();
    await pool.end();
  });

  describe('create and read', () => {
    it('lets a designer create a project with an empty draft sized to the machine hoop', async () => {
      const res = await call(DESIGNER, 'POST', '/design-projects', {
        body: { title: '  Heart  ', machineProfileId: BROTHER_5X7 },
      });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get('location'), `/api/v1/design-projects/${res.body.id}`);
      assert.equal(res.body.title, 'Heart');
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.visibility, 'private');
      assert.equal(res.body.draftRevision, 0);
      assert.equal(res.body.currentVersionId, null);

      const detail = await call(DESIGNER, 'GET', `/design-projects/${res.body.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.headers.get('etag'), '"0"');
      assert.deepEqual(detail.body.draft, {
        schemaVersion: 1,
        units: 'mm',
        canvas: { width: 130, height: 180 },
        threads: [],
        objects: [],
      });
      assert.deepEqual(detail.body.permissions, {
        canEdit: true,
        canExport: true,
        canSubmit: true,
        canManageCollaborators: true,
      });
    });

    it('forbids customers from creating projects (role check → 403)', async () => {
      const res = await call(CUSTOMER, 'POST', '/design-projects', { body: { title: 'x' } });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('rejects an unknown machine profile and unknown fields with 422', async () => {
      const unknown = await call(DESIGNER, 'POST', '/design-projects', {
        body: { title: 'x', machineProfileId: '00000000-0000-7000-8000-000000000999' },
      });
      assert.equal(unknown.status, 422);
      assert.deepEqual(unknown.body.error.details, [
        { path: '/machineProfileId', issue: 'is not an available machine profile' },
      ]);
      const extra = await call(DESIGNER, 'POST', '/design-projects', {
        body: { title: 'x', status: 'published' },
      });
      assert.equal(extra.status, 422);
      assert.deepEqual(extra.body.error.details, [
        { path: '/status', issue: 'is not an allowed field' },
      ]);
    });

    it('hides projects from strangers with 404, and lets staff read them', async () => {
      const project = await createProject();
      const stranger = await call(STRANGER, 'GET', `/design-projects/${project.id}`);
      assert.equal(stranger.status, 404);
      assert.equal((await call(STRANGER, 'GET', '/design-projects/not-a-uuid')).status, 404);
      const staff = await call(MODERATOR, 'GET', `/design-projects/${project.id}`);
      assert.equal(staff.status, 200);
      assert.equal(staff.body.permissions.canEdit, false);
    });
  });

  describe('metadata', () => {
    it('lets editors rename, but only the owner changes visibility', async () => {
      const project = await createProject();
      await addCollaborator(project.id, EDITOR, 'editor');

      const renamed = await call(EDITOR, 'PATCH', `/design-projects/${project.id}`, {
        body: { title: 'Renamed', description: 'by editor' },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.title, 'Renamed');
      assert.equal(renamed.body.description, 'by editor');

      const visibility = await call(EDITOR, 'PATCH', `/design-projects/${project.id}`, {
        body: { visibility: 'shared' },
      });
      assert.equal(visibility.status, 403);

      const owner = await call(DESIGNER, 'PATCH', `/design-projects/${project.id}`, {
        body: { visibility: 'shared', machineProfileId: null },
      });
      assert.equal(owner.status, 200);
      assert.equal(owner.body.visibility, 'shared');
    });

    it('rejects marketplace visibility and an empty patch', async () => {
      const project = await createProject();
      const marketplace = await call(DESIGNER, 'PATCH', `/design-projects/${project.id}`, {
        body: { visibility: 'marketplace' },
      });
      assert.equal(marketplace.status, 422);
      const empty = await call(DESIGNER, 'PATCH', `/design-projects/${project.id}`, { body: {} });
      assert.equal(empty.status, 422);
    });

    it('refuses visibility changes on a published design with 409 INVALID_STATE', async () => {
      const project = await createProject();
      await pool.execute(
        `UPDATE design_projects SET visibility = 'marketplace', status = 'published' WHERE id = ?`,
        [project.id],
      );
      const res = await call(DESIGNER, 'PATCH', `/design-projects/${project.id}`, {
        body: { visibility: 'private' },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'INVALID_STATE');
    });
  });

  describe('draft autosave', () => {
    it('saves with the current revision and returns the next one as ETag', async () => {
      const project = await createProject();
      const res = await saveDraft(DESIGNER, project.id, 0, heartDocument());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { draftRevision: 1 });
      assert.equal(res.headers.get('etag'), '"1"');

      const detail = await call(DESIGNER, 'GET', `/design-projects/${project.id}`);
      assert.deepEqual(detail.body.draft, heartDocument(), 'stored exactly as sent');
      assert.equal(detail.body.draftRevision, 1);
    });

    it('IT-09: a stale If-Match gets 409 DRAFT_CONFLICT and the draft is unchanged', async () => {
      const project = await createProject();
      await saveDraft(DESIGNER, project.id, 0, heartDocument());
      const stale = await saveDraft(
        DESIGNER,
        project.id,
        0,
        heartDocument({ canvas: { width: 90, height: 90 } }),
      );
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'DRAFT_CONFLICT');
      assert.deepEqual(stale.body.error.details, [
        { path: '/If-Match', issue: 'current draftRevision is 1' },
      ]);

      const detail = await call(DESIGNER, 'GET', `/design-projects/${project.id}`);
      assert.equal(detail.body.draftRevision, 1);
      assert.deepEqual(detail.body.draft.canvas, { width: 100, height: 100 });
    });

    it('lets exactly one of two concurrent saves with the same revision win', async () => {
      const project = await createProject();
      const results = await Promise.all([
        saveDraft(DESIGNER, project.id, 0, heartDocument()),
        saveDraft(DESIGNER, project.id, 0, heartDocument({ canvas: { width: 80, height: 80 } })),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    });

    it('requires If-Match (400) and rejects invalid documents with 422 details', async () => {
      const project = await createProject();
      const missing = await call(DESIGNER, 'PUT', `/design-projects/${project.id}/draft`, {
        body: heartDocument(),
      });
      assert.equal(missing.status, 400);

      const doc = heartDocument();
      doc.objects[1].stitch.threadId = 'missing';
      doc.objects[1].id = 'outline';
      const invalid = await saveDraft(DESIGNER, project.id, 0, doc);
      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');
      assert.deepEqual(invalid.body.error.details, [
        { path: '/objects/1/id', issue: 'duplicates object id "outline"' },
        { path: '/objects/1/stitch/threadId', issue: 'thread "missing" is not in threads' },
      ]);
    });

    it('accepts a document over 1 MB (documents may be up to 10 MB)', async () => {
      const project = await createProject();
      const doc = heartDocument();
      const segments = Array.from({ length: 130_000 }, (_, i) => `L${10 + (i % 80)}.25 50.25`).join(
        ' ',
      );
      doc.objects[1].geometry.d = `M10 50 ${segments}`;
      assert.ok(JSON.stringify(doc).length > 1_000_000);
      const res = await saveDraft(DESIGNER, project.id, 0, doc);
      assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    });

    it('lets viewers read but not save, and makes archived projects read-only', async () => {
      const project = await createProject();
      await addCollaborator(project.id, VIEWER, 'viewer');
      const read = await call(VIEWER, 'GET', `/design-projects/${project.id}`);
      assert.equal(read.status, 200);
      assert.equal(read.body.permissions.canEdit, false);
      assert.equal((await saveDraft(VIEWER, project.id, 0, heartDocument())).status, 403);

      await pool.execute(`UPDATE design_projects SET status = 'archived' WHERE id = ?`, [
        project.id,
      ]);
      const archived = await saveDraft(DESIGNER, project.id, 0, heartDocument());
      assert.equal(archived.status, 409);
      assert.equal(archived.body.error.code, 'INVALID_STATE');
    });
  });

  describe('versions', () => {
    it('IT-10: snapshotting an identical draft twice returns the same version', async () => {
      const project = await createProject();
      await saveDraft(DESIGNER, project.id, 0, heartDocument());

      const first = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`, {
        body: { label: 'First pass' },
      });
      assert.equal(first.status, 201);
      assert.equal(first.body.versionNumber, 1);
      assert.equal(first.body.label, 'First pass');
      assert.match(first.body.documentSha256, /^[0-9a-f]{64}$/);

      const again = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      assert.equal(again.status, 200);
      assert.equal(again.body.id, first.body.id);
      assert.equal(again.body.documentSha256, first.body.documentSha256);

      const detail = await call(DESIGNER, 'GET', `/design-projects/${project.id}`);
      assert.equal(detail.body.currentVersionId, first.body.id);
    });

    it('treats key order as irrelevant but a real change as a new version', async () => {
      const project = await createProject();
      const doc = heartDocument();
      await saveDraft(DESIGNER, project.id, 0, doc);
      const v1 = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);

      const reordered = Object.fromEntries(Object.entries(doc).reverse());
      await saveDraft(DESIGNER, project.id, 1, reordered);
      const same = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      assert.equal(same.status, 200);
      assert.equal(same.body.id, v1.body.id);

      await saveDraft(
        DESIGNER,
        project.id,
        2,
        heartDocument({ canvas: { width: 90, height: 90 } }),
      );
      const v2 = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      assert.equal(v2.status, 201);
      assert.equal(v2.body.versionNumber, 2);
    });

    it('renumbers sequences on snapshot and stores the canonical document', async () => {
      const project = await createProject();
      const doc = heartDocument();
      doc.objects[0].sequence = 7;
      doc.objects[1].sequence = 7;
      await saveDraft(DESIGNER, project.id, 0, doc);
      const v = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      const [[row]] = await pool.execute(
        `SELECT document_json FROM design_project_versions WHERE id = ?`,
        [v.body.id],
      );
      assert.deepEqual(
        row.document_json.objects.map((o) => [o.id, o.sequence]),
        [
          ['outline', 1],
          ['underline', 2],
        ],
      );
    });

    it('gives two concurrent snapshots of one draft a single version', async () => {
      const project = await createProject();
      await saveDraft(DESIGNER, project.id, 0, heartDocument());
      const results = await Promise.all([
        call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`),
        call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
      assert.equal(results[0].body.id, results[1].body.id);
    });

    it('lists history newest first with cursor pagination', async () => {
      const project = await createProject();
      for (let i = 0; i < 3; i++) {
        await saveDraft(
          DESIGNER,
          project.id,
          i,
          heartDocument({ canvas: { width: 100 + i, height: 100 } }),
        );
        await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      }
      const page1 = await call(DESIGNER, 'GET', `/design-projects/${project.id}/versions?limit=2`);
      assert.deepEqual(
        page1.body.data.map((v) => v.versionNumber),
        [3, 2],
      );
      assert.ok(page1.body.page.nextCursor);
      const page2 = await call(
        DESIGNER,
        'GET',
        `/design-projects/${project.id}/versions?limit=2&cursor=${page1.body.page.nextCursor}`,
      );
      assert.deepEqual(
        page2.body.data.map((v) => v.versionNumber),
        [1],
      );
      assert.equal(page2.body.page.nextCursor, null);
      assert.equal(
        (await call(STRANGER, 'GET', `/design-projects/${project.id}/versions`)).status,
        404,
      );
    });

    it('lets viewers list but not snapshot', async () => {
      const project = await createProject();
      await addCollaborator(project.id, VIEWER, 'viewer');
      assert.equal(
        (await call(VIEWER, 'POST', `/design-projects/${project.id}/versions`)).status,
        403,
      );
      assert.equal(
        (await call(VIEWER, 'GET', `/design-projects/${project.id}/versions`)).status,
        200,
      );
    });
  });

  describe('restore (S8-01)', () => {
    const restore = (user, id, versionId, revision) =>
      call(user, 'POST', `/design-projects/${id}/versions/${versionId}/restore`, {
        headers: { 'If-Match': `"${revision}"` },
      });

    it('makes the version the draft and snapshots the current draft first', async () => {
      const project = await createProject();
      await saveDraft(DESIGNER, project.id, 0, heartDocument());
      const v1 = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      const changed = heartDocument({ canvas: { width: 90, height: 90 } });
      await saveDraft(DESIGNER, project.id, 1, changed);

      const res = await restore(DESIGNER, project.id, v1.body.id, 2);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.draftRevision, 3);
      assert.equal(res.headers.get('etag'), '"3"');

      const detail = await call(DESIGNER, 'GET', `/design-projects/${project.id}`);
      assert.equal(detail.body.draft.canvas.width, heartDocument().canvas.width);
      const versions = await call(DESIGNER, 'GET', `/design-projects/${project.id}/versions`);
      const [checkpoint] = versions.body.data;
      assert.equal(checkpoint.versionNumber, 2);
      assert.equal(checkpoint.reason, 'checkpoint');
      assert.equal(checkpoint.label, 'Before restoring version 1');
      assert.equal(detail.body.currentVersionId, checkpoint.id);

      // The changed draft is kept in the checkpoint: restoring it brings it back.
      const back = await restore(DESIGNER, project.id, checkpoint.id, 3);
      assert.equal(back.status, 200);
      const again = await call(DESIGNER, 'GET', `/design-projects/${project.id}`);
      assert.equal(again.body.draft.canvas.width, 90);
    });

    it('does not snapshot a draft that equals the latest version', async () => {
      const project = await createProject();
      await saveDraft(DESIGNER, project.id, 0, heartDocument());
      const v1 = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);
      assert.equal((await restore(DESIGNER, project.id, v1.body.id, 1)).status, 200);
      const versions = await call(DESIGNER, 'GET', `/design-projects/${project.id}/versions`);
      assert.equal(versions.body.data.length, 1);
    });

    it('checks If-Match, the version, and edit rights', async () => {
      const project = await createProject();
      await saveDraft(DESIGNER, project.id, 0, heartDocument());
      const v1 = await call(DESIGNER, 'POST', `/design-projects/${project.id}/versions`);

      const stale = await restore(DESIGNER, project.id, v1.body.id, 0);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'DRAFT_CONFLICT');
      const noHeader = await call(
        DESIGNER,
        'POST',
        `/design-projects/${project.id}/versions/${v1.body.id}/restore`,
      );
      assert.equal(noHeader.status, 400);

      const other = await createProject();
      await saveDraft(DESIGNER, other.id, 0, heartDocument());
      const foreign = await call(DESIGNER, 'POST', `/design-projects/${other.id}/versions`);
      assert.equal((await restore(DESIGNER, project.id, foreign.body.id, 1)).status, 404);
      assert.equal((await restore(DESIGNER, project.id, 'not-a-uuid', 1)).status, 404);

      await addCollaborator(project.id, VIEWER, 'viewer');
      assert.equal((await restore(VIEWER, project.id, v1.body.id, 1)).status, 403);
      await addCollaborator(project.id, EDITOR, 'editor');
      assert.equal((await restore(EDITOR, project.id, v1.body.id, 1)).status, 200);
      assert.equal((await restore(STRANGER, project.id, v1.body.id, 2)).status, 404);
    });
  });

  describe('duplicate (S7-05)', () => {
    const duplicate = (user, id, { body, key } = {}) =>
      call(user, 'POST', `/design-projects/${id}/duplicate`, {
        body,
        headers: key ? { 'Idempotency-Key': key } : {},
      });

    it('copies the current draft into a new private project with version 1', async () => {
      const source = await createProject(DESIGNER, {
        title: 'Rose',
        machineProfileId: BROTHER_5X7,
      });
      await saveDraft(DESIGNER, source.id, 0, heartDocument());

      const res = await duplicate(DESIGNER, source.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.headers.get('location'), `/api/v1/design-projects/${res.body.id}`);
      assert.notEqual(res.body.id, source.id);
      assert.equal(res.body.title, 'Copy of Rose');
      assert.equal(res.body.ownerUserId, DESIGNER);
      assert.equal(res.body.visibility, 'private');
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.draftRevision, 0);
      assert.equal(res.body.machineProfileId, BROTHER_5X7);

      const versions = await call(DESIGNER, 'GET', `/design-projects/${res.body.id}/versions`);
      assert.equal(versions.body.data.length, 1);
      assert.equal(versions.body.data[0].versionNumber, 1);
      assert.equal(versions.body.data[0].reason, 'duplicate');
      assert.equal(versions.body.data[0].id, res.body.currentVersionId);

      const copy = await call(DESIGNER, 'GET', `/design-projects/${res.body.id}`);
      assert.deepEqual(
        copy.body.draft.objects.map((o) => o.id),
        heartDocument().objects.map((o) => o.id),
      );
      const [[row]] = await pool.execute(
        'SELECT duplicated_from_project_id FROM design_projects WHERE id = ?',
        [res.body.id],
      );
      assert.equal(row.duplicated_from_project_id, source.id);
    });

    it('copies a chosen version, not the newer draft, and takes a title', async () => {
      const source = await createProject();
      await saveDraft(DESIGNER, source.id, 0, heartDocument());
      const v1 = await call(DESIGNER, 'POST', `/design-projects/${source.id}/versions`);
      await saveDraft(DESIGNER, source.id, 1, heartDocument({ canvas: { width: 90, height: 90 } }));

      const res = await duplicate(DESIGNER, source.id, {
        body: { versionId: v1.body.id, title: '  From v1  ' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.title, 'From v1');
      const versions = await call(DESIGNER, 'GET', `/design-projects/${res.body.id}/versions`);
      assert.equal(versions.body.data[0].documentSha256, v1.body.documentSha256);
    });

    it('rejects a version of another project and unknown fields', async () => {
      const source = await createProject();
      const other = await createProject();
      await saveDraft(DESIGNER, other.id, 0, heartDocument());
      const foreign = await call(DESIGNER, 'POST', `/design-projects/${other.id}/versions`);

      const res = await duplicate(DESIGNER, source.id, { body: { versionId: foreign.body.id } });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.details[0].path, '/versionId');
      assert.equal((await duplicate(DESIGNER, source.id, { body: { rights: [] } })).status, 422);
      assert.equal(
        (await duplicate(DESIGNER, source.id, { body: { title: 'x'.repeat(201) } })).status,
        422,
      );
    });

    it('lets a viewer copy into a project of their own; strangers and customers cannot', async () => {
      const source = await createProject();
      await addCollaborator(source.id, VIEWER, 'viewer');

      const res = await duplicate(VIEWER, source.id);
      assert.equal(res.status, 201);
      assert.equal(res.body.ownerUserId, VIEWER);
      assert.equal((await call(DESIGNER, 'GET', `/design-projects/${res.body.id}`)).status, 404);

      assert.equal((await duplicate(STRANGER, source.id)).status, 404);
      assert.equal((await duplicate(CUSTOMER, source.id)).status, 403);
    });

    it('replays the same Idempotency-Key and rejects it with a different body', async () => {
      const source = await createProject();
      const first = await duplicate(DESIGNER, source.id, { body: { title: 'Once' }, key: 'dup-1' });
      const again = await duplicate(DESIGNER, source.id, { body: { title: 'Once' }, key: 'dup-1' });
      assert.equal(first.status, 201);
      assert.equal(again.status, 201);
      assert.equal(again.body.id, first.body.id);

      const changed = await duplicate(DESIGNER, source.id, {
        body: { title: 'Twice' },
        key: 'dup-1',
      });
      assert.equal(changed.status, 409);
      assert.equal(changed.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

      // Keys are per user.
      await addCollaborator(source.id, EDITOR, 'editor');
      const theirs = await duplicate(EDITOR, source.id, { body: { title: 'Once' }, key: 'dup-1' });
      assert.equal(theirs.status, 201);
      assert.notEqual(theirs.body.id, first.body.id);
    });

    it('makes one copy when the same key arrives twice at once', async () => {
      const source = await createProject();
      const results = await Promise.all(
        [1, 2, 3].map(() => duplicate(DESIGNER, source.id, { key: 'dup-race' })),
      );
      assert.deepEqual(
        results.map((r) => r.status),
        [201, 201, 201],
      );
      assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    });
  });

  describe('list', () => {
    const OWNER = '0190f0a0-0000-7000-8000-0000000000b1';
    const SHARER = '0190f0a0-0000-7000-8000-0000000000b2';
    let owned;
    let shared;

    before(async () => {
      await insertUsers(pool, OWNER, SHARER);
      await server.close();
      server = await startApp({
        db: pool,
        verifyToken: auth.verifyToken,
        roles: { [OWNER]: ['designer'], [SHARER]: ['designer'] },
      });
      owned = [];
      for (const title of ['A', 'B', 'C']) owned.push(await createProject(OWNER, { title }));
      shared = await createProject(SHARER, { title: 'Shared with owner' });
      await addCollaborator(shared.id, OWNER, 'viewer');
      const revoked = await createProject(SHARER, { title: 'Revoked' });
      await addCollaborator(revoked.id, OWNER, 'editor');
      await pool.execute(
        `UPDATE design_collaborators SET revoked_at = CURRENT_TIMESTAMP(3) WHERE project_id = ?`,
        [revoked.id],
      );
    });

    it('lists owned and actively shared projects, newest first, across pages', async () => {
      const seen = [];
      let cursor = '';
      for (let i = 0; i < 5 && cursor !== null; i++) {
        const res = await call(
          OWNER,
          'GET',
          `/design-projects?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        assert.equal(res.status, 200);
        seen.push(...res.body.data.map((p) => p.title));
        cursor = res.body.page.nextCursor;
      }
      assert.deepEqual(seen, ['Shared with owner', 'C', 'B', 'A']);
    });

    it('filters by scope and status', async () => {
      const ownedOnly = await call(OWNER, 'GET', '/design-projects?scope=owned');
      assert.deepEqual(
        ownedOnly.body.data.map((p) => p.id),
        owned.map((p) => p.id).reverse(),
      );
      const sharedOnly = await call(OWNER, 'GET', '/design-projects?scope=shared');
      assert.deepEqual(
        sharedOnly.body.data.map((p) => p.id),
        [shared.id],
      );
      const archived = await call(OWNER, 'GET', '/design-projects?status=archived');
      assert.deepEqual(archived.body.data, []);
    });

    it('rejects bad query parameters', async () => {
      assert.equal((await call(OWNER, 'GET', '/design-projects?limit=500')).status, 422);
      assert.equal((await call(OWNER, 'GET', '/design-projects?scope=everyone')).status, 422);
      assert.equal((await call(OWNER, 'GET', '/design-projects?cursor=garbage')).status, 400);
    });
  });
});

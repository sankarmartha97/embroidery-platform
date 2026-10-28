// S8-04: collaborators API (owner only) on real MySQL. SEC-T05 (revoke ends access at once) is
// also in the IDOR matrix.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { heartDocument } from '../helpers/documents.js';
import { createAuthKit } from '../helpers/jwt.js';

const OWNER = '0190f0a0-0000-7000-8000-000000000c01';
const FRIEND = '0190f0a0-0000-7000-8000-000000000c02';
const OTHER = '0190f0a0-0000-7000-8000-000000000c03';
const NOBODY = '0190f0a0-0000-7000-8000-000000000cff'; // not in users

describe('collaborators API', () => {
  let pool;
  let server;
  let auth;
  let project;

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
  const base = () => `/design-projects/${project.id}/collaborators`;
  const invite = (body, user = OWNER) => call(user, 'POST', base(), { body });

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, OWNER, FRIEND, OTHER);
    auth = await createAuthKit();
    server = await startApp({
      db: pool,
      verifyToken: auth.verifyToken,
      roles: { [OWNER]: ['designer'], [FRIEND]: ['designer'], [OTHER]: ['designer'] },
    });
    project = (await call(OWNER, 'POST', '/design-projects', { body: { title: 'Shared' } })).body;
    await call(OWNER, 'PUT', `/design-projects/${project.id}/draft`, {
      body: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
  });
  after(async () => {
    await server.close();
    await pool.end();
  });

  it('invites a viewer who can then read but not edit', async () => {
    const res = await invite({ userId: FRIEND, role: 'viewer' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.userId, FRIEND);
    assert.equal(res.body.role, 'viewer');
    assert.equal(res.body.canExport, false);
    assert.equal(res.body.invitedBy, OWNER);

    const list = await call(OWNER, 'GET', base());
    assert.deepEqual(
      list.body.data.map((c) => c.userId),
      [FRIEND],
    );
    const detail = await call(FRIEND, 'GET', `/design-projects/${project.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.permissions.canEdit, false);
    assert.equal(detail.body.permissions.canManageCollaborators, false);
  });

  it('rejects a second invite, the owner, unknown users and bad bodies', async () => {
    assert.equal((await invite({ userId: FRIEND, role: 'editor' })).status, 409);
    const self = await invite({ userId: OWNER, role: 'editor' });
    assert.equal(self.status, 422);
    assert.equal(self.body.error.details[0].path, '/userId');
    const unknown = await invite({ userId: NOBODY, role: 'viewer' });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.details[0].issue, 'is not a known user');
    assert.equal((await invite({ userId: OTHER, role: 'owner' })).status, 422);
    assert.equal((await invite({ userId: OTHER })).status, 422);
  });

  it('changes role and export permission, which the collaborator sees at once', async () => {
    const res = await call(OWNER, 'PATCH', `${base()}/${FRIEND}`, {
      body: { role: 'editor', canExport: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'editor');
    assert.equal(res.body.canExport, true);
    const detail = await call(FRIEND, 'GET', `/design-projects/${project.id}`);
    assert.equal(detail.body.permissions.canEdit, true);
    assert.equal(detail.body.permissions.canExport, true);

    assert.equal((await call(OWNER, 'PATCH', `${base()}/${FRIEND}`, { body: {} })).status, 422);
    assert.equal(
      (await call(OWNER, 'PATCH', `${base()}/${OTHER}`, { body: { role: 'viewer' } })).status,
      404,
    );
  });

  it('lets only the owner manage: collaborators get 403, strangers 404', async () => {
    assert.equal((await call(FRIEND, 'GET', base())).status, 403);
    assert.equal((await invite({ userId: OTHER, role: 'viewer' }, FRIEND)).status, 403);
    assert.equal((await call(FRIEND, 'DELETE', `${base()}/${FRIEND}`)).status, 403);
    assert.equal((await call(OTHER, 'GET', base())).status, 404);
    assert.equal((await invite({ userId: OTHER, role: 'viewer' }, OTHER)).status, 404);
  });

  it('revokes at once, and a re-invite gives access back with the new role', async () => {
    const revoked = await call(OWNER, 'DELETE', `${base()}/${FRIEND}`);
    assert.equal(revoked.status, 204);
    assert.equal(revoked.body, null);
    assert.equal((await call(FRIEND, 'GET', `/design-projects/${project.id}`)).status, 404);
    assert.deepEqual((await call(OWNER, 'GET', base())).body.data, []);
    assert.equal((await call(OWNER, 'DELETE', `${base()}/${FRIEND}`)).status, 404);
    assert.equal((await call(OWNER, 'DELETE', `${base()}/not-a-uuid`)).status, 404);

    const again = await invite({ userId: FRIEND, role: 'viewer' });
    assert.equal(again.status, 201);
    assert.equal(again.body.canExport, false);
    const detail = await call(FRIEND, 'GET', `/design-projects/${project.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.permissions.canEdit, false);
  });
});

// "My Machine" API end to end: HTTP → service → repository → real MySQL.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from '../helpers/app.js';
import { createTestPool, insertUsers, resetDatabase } from '../helpers/db.js';
import { createAuthKit } from '../helpers/jwt.js';

const ALICE = '0190f0a0-0000-7000-8000-00000000a11c';
const BOB = '0190f0a0-0000-7000-8000-0000000000b0';
const machine = (overrides = {}) => ({
  machineBrand: 'Brother',
  machineModel: 'SE1900',
  preferredFormat: 'PES',
  hoops: [{ name: '5x7', widthMm: 130, heightMm: 180 }],
  ...overrides,
});

describe('/me/machines', () => {
  let pool;
  let server;
  let auth;
  let call;

  before(async () => {
    await resetDatabase();
    pool = createTestPool();
    await insertUsers(pool, ALICE, BOB);
    auth = await createAuthKit();
    server = await startApp({ db: pool, verifyToken: auth.verifyToken });
    call = async (user, method, body) => {
      const res = await fetch(`${server.url}/api/v1/me/machines`, {
        method,
        headers: {
          Authorization: `Bearer ${await auth.sign(user)}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
  });
  after(async () => {
    await server.close();
    await pool.end();
  });

  it('starts empty', async () => {
    assert.deepEqual(await call(ALICE, 'GET'), { status: 200, body: { data: [] } });
  });

  it('makes the first machine the default automatically', async () => {
    const res = await call(ALICE, 'POST', machine({ nickname: 'Home' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.isDefault, true);
    assert.match(res.body.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(res.body.hoops, [{ name: '5x7', widthMm: 130, heightMm: 180 }]);
  });

  it('keeps exactly one default when a new default is added', async () => {
    const second = await call(ALICE, 'POST', machine({ machineModel: 'Altair', isDefault: true }));
    assert.equal(second.body.isDefault, true);
    const list = (await call(ALICE, 'GET')).body.data;
    assert.equal(list.length, 2);
    assert.equal(list.filter((m) => m.isDefault).length, 1);
    assert.equal(list[0].machineModel, 'Altair', 'default machine is listed first');
  });

  it("never shows one user's machines to another", async () => {
    assert.deepEqual((await call(BOB, 'GET')).body.data, []);
  });

  it('rejects formats that are not in the registry with 422 UNSUPPORTED_FORMAT', async () => {
    const res = await call(ALICE, 'POST', machine({ preferredFormat: 'XYZ' }));
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'UNSUPPORTED_FORMAT');
  });

  it('rejects hoops outside 30–600 mm with field-level details', async () => {
    const res = await call(
      ALICE,
      'POST',
      machine({ hoops: [{ name: 'tiny', widthMm: 10, heightMm: 180 }] }),
    );
    assert.equal(res.status, 422);
    assert.deepEqual(
      res.body.error.details.map((d) => d.path),
      ['/hoops/0/widthMm'],
    );
  });

  it('enforces the per-user machine limit', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await call(BOB, 'POST', machine())).status, 201);
    assert.equal((await call(BOB, 'POST', machine())).status, 201); // 9
    assert.equal((await call(BOB, 'POST', machine())).status, 201); // 10
    const over = await call(BOB, 'POST', machine());
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'VALIDATION_FAILED');
  });

  it('serves machine profiles: system presets for everyone', async () => {
    const res = await fetch(`${server.url}/api/v1/machine-profiles`, {
      headers: { Authorization: `Bearer ${await auth.sign(ALICE)}` },
    });
    const { data } = await res.json();
    assert.equal(data.length, 5);
    assert.ok(data.every((p) => p.isSystemPreset));
    assert.equal(data.find((p) => p.name === 'Brother 5x7').hoopHeightMm, 180);
  });
});

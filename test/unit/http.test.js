// S1-09 / S1-10 done-when: error/404/500 contract tests and valid/expired/invalid token tests.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import pino from 'pino';
import { correlation } from '../../src/http/correlation.js';
import { createErrorHandler } from '../../src/http/errors.js';
import { startApp, noDb } from '../helpers/app.js';
import { createAuthKit } from '../helpers/jwt.js';

const USER = '0190f0a0-0000-7000-8000-000000000001';

describe('HTTP contract', () => {
  let server;
  let auth;

  before(async () => {
    auth = await createAuthKit();
    server = await startApp({ db: noDb, verifyToken: auth.verifyToken });
  });
  after(() => server.close());

  it('serves liveness and readiness without auth', async () => {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal((await fetch(`${server.url}/ready`)).status, 200);
  });

  it('returns the 404 envelope with a correlation id', async () => {
    const res = await fetch(`${server.url}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.correlationId, res.headers.get('x-correlation-id'));
  });

  it('echoes a safe incoming correlation id and replaces an unsafe one', async () => {
    const ok = await fetch(`${server.url}/health`, { headers: { 'X-Correlation-Id': 'abc-123' } });
    assert.equal(ok.headers.get('x-correlation-id'), 'abc-123');
    const bad = await fetch(`${server.url}/health`, { headers: { 'X-Correlation-Id': 'bad id!' } });
    assert.notEqual(bad.headers.get('x-correlation-id'), 'bad id!');
  });

  it('rejects a missing token with 401 UNAUTHENTICATED', async () => {
    const res = await fetch(`${server.url}/api/v1/machine-formats`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'UNAUTHENTICATED');
  });

  it('accepts a valid token', async () => {
    const token = await auth.sign(USER);
    const res = await fetch(`${server.url}/api/v1/machine-formats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const codes = (await res.json()).data.map((f) => f.code);
    assert.deepEqual(codes, ['DST', 'PES', 'JEF']);
  });

  for (const [name, opts] of [
    ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['wrong issuer', { iss: 'https://evil.test/' }],
    ['wrong audience', { aud: 'someone-else' }],
    ['bad signature', { key: 'other' }],
  ]) {
    it(`rejects a token with ${name}`, async () => {
      const token = await auth.sign(USER, {
        ...opts,
        ...(opts.key === 'other' ? { key: auth.otherPrivateKey } : {}),
      });
      const res = await fetch(`${server.url}/api/v1/machine-formats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 401);
    });
  }

  it('rejects a token whose subject is not a user id', async () => {
    const token = await auth.sign('not-a-uuid');
    const res = await fetch(`${server.url}/api/v1/machine-formats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  });

  it('maps malformed JSON to 400 BAD_REQUEST', async () => {
    const token = await auth.sign(USER);
    const res = await fetch(`${server.url}/api/v1/me/machines`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{"machineBrand":',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_REQUEST');
  });

  it('rejects unknown and missing fields with 422 VALIDATION_FAILED before touching the database', async () => {
    const token = await auth.sign(USER);
    const res = await fetch(`${server.url}/api/v1/me/machines`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineBrand: 'Brother',
        preferredFormat: 'PES',
        hoops: [{ name: '5x7', widthMm: 130, heightMm: 180, colour: 'red' }],
        surprise: true,
      }),
    });
    assert.equal(res.status, 422);
    const { error } = await res.json();
    assert.equal(error.code, 'VALIDATION_FAILED');
    const paths = error.details.map((d) => d.path).sort();
    assert.deepEqual(paths, ['/hoops/0/colour', '/machineModel', '/surprise']);
  });
});

describe('500 handling', () => {
  it('hides internal errors behind 500 INTERNAL', async () => {
    const logger = pino({ level: 'silent' });
    const app = express();
    app.use(correlation(logger));
    app.get('/boom', () => {
      throw new Error('database password is hunter2');
    });
    app.use(createErrorHandler(logger));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.match(text, /"code":"INTERNAL"/);
      assert.doesNotMatch(text, /hunter2|at /);
    } finally {
      server.close();
    }
  });
});

describe('rate limiting', () => {
  it('returns 429 RATE_LIMITED with Retry-After once the window is used up', async () => {
    const auth = await createAuthKit();
    const server = await startApp({
      db: noDb,
      verifyToken: auth.verifyToken,
      rateLimit: { windowMs: 60_000, max: 2 },
    });
    try {
      const token = await auth.sign(USER);
      const call = () =>
        fetch(`${server.url}/api/v1/machine-formats`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      assert.equal((await call()).status, 200);
      assert.equal((await call()).status, 200);
      const limited = await call();
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    } finally {
      await server.close();
    }
  });
});

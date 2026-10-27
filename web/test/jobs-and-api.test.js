import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, apiFetch } from '../lib/api.js';
import { pollDelay, pollJob } from '../lib/jobs.js';

describe('job polling', () => {
  it('polls every 1 s, then 2 s, backing off to 5 s', () => {
    assert.deepEqual([0, 4, 5, 14, 15, 100].map(pollDelay), [1000, 1000, 2000, 2000, 5000, 5000]);
  });

  it('stops at a terminal status and reports every state', async () => {
    const states = ['queued', 'running', 'running', 'succeeded'];
    const seen = [];
    const slept = [];
    const job = await pollJob('j1', {
      getJob: async () => ({ id: 'j1', status: states.shift() }),
      onUpdate: (j) => seen.push(j.status),
      sleep: async (ms) => slept.push(ms),
    });
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(seen, ['queued', 'running', 'running', 'succeeded']);
    assert.deepEqual(slept, [1000, 1000, 1000]);
  });
});

describe('apiFetch', () => {
  const response = (status, body) => ({
    ok: status < 400,
    status,
    headers: new Headers(),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  it('calls the same-origin proxy and returns data', async () => {
    let called;
    const { data } = await apiFetch('/design-projects', {
      fetchImpl: async (url, init) => {
        called = { url, init };
        return response(200, { data: [] });
      },
    });
    assert.equal(called.url, '/api/v1/design-projects');
    assert.equal(called.init.credentials, 'same-origin');
    assert.deepEqual(data, { data: [] });
  });

  it('turns the error envelope into an ApiError and redirects on 401', async () => {
    const envelope = {
      error: {
        code: 'DRAFT_CONFLICT',
        message: 'Changed',
        correlationId: 'c-1',
        details: [{ path: '/If-Match' }],
      },
    };
    await assert.rejects(
      apiFetch('/x', { fetchImpl: async () => response(409, envelope) }),
      (err) =>
        err instanceof ApiError &&
        err.code === 'DRAFT_CONFLICT' &&
        err.correlationId === 'c-1' &&
        err.status === 409,
    );
    let redirected = false;
    await assert.rejects(
      apiFetch('/x', {
        fetchImpl: async () => response(401, { error: { code: 'UNAUTHENTICATED' } }),
        onUnauthenticated: () => (redirected = true),
      }),
    );
    assert.equal(redirected, true);
  });
});

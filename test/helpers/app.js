import pino from 'pino';
import { createApp } from '../../src/app.js';
import { createStaticEntitlementProvider } from '../../src/modules/entitlements/index.js';
import { createStaticRolesProvider } from '../../src/modules/identity/index.js';

/** Starts the app on an ephemeral port. Returns { url, close }. */
export async function startApp({
  db,
  verifyToken,
  roles = {},
  rateLimit = { windowMs: 60_000, max: 1000 },
  store,
  entitlements = {},
  downloadTtlSeconds = 300,
  logger = pino({ level: 'silent' }),
}) {
  const app = createApp({
    db,
    logger,
    verifyToken,
    rolesProvider: createStaticRolesProvider(roles),
    rateLimit,
    allowUngatedFormats: true,
    engineName: 'fake',
    store,
    entitlements: createStaticEntitlementProvider(entitlements),
    downloadTtlSeconds,
    ipHashSecret: 'test-ip-secret',
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A db stand-in for tests that never reach a repository. */
export const noDb = {
  async query() {
    return [[{ 1: 1 }]];
  },
  async execute() {
    throw new Error('unexpected database call in a unit test');
  },
  async getConnection() {
    throw new Error('unexpected database call in a unit test');
  },
};

import { createApp } from './app.js';
import { createArtifactStore, createS3Client } from './aws/s3.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { createTokenVerifier } from './http/auth.js';
import { logger } from './lib/logger.js';
import { createStaticEntitlementProvider } from './modules/entitlements/index.js';
import { createStaticRolesProvider } from './modules/identity/index.js';

if (!env.S3_BUCKET_ARTIFACTS) {
  logger.error('S3_BUCKET_ARTIFACTS is not set');
  process.exit(1);
}

const verifyToken = await createTokenVerifier({
  issuer: env.AUTH_JWT_ISSUER,
  audience: env.AUTH_JWT_AUDIENCE,
  jwksUrl: env.AUTH_JWKS_URL,
  publicKeyPem: env.AUTH_JWT_PUBLIC_KEY,
  algorithms: env.AUTH_JWT_ALGORITHMS,
});

const app = createApp({
  db: pool,
  logger,
  verifyToken,
  rolesProvider: createStaticRolesProvider(env.DEV_ROLE_ASSIGNMENTS),
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    jobsMax: env.RATE_LIMIT_JOBS_MAX,
    downloadsMax: env.RATE_LIMIT_DOWNLOADS_MAX,
  },
  allowUngatedFormats: env.FORMATS_ALLOW_UNGATED,
  engineName: env.DIGITIZING_ENGINE,
  store: createArtifactStore({ client: createS3Client(), bucket: env.S3_BUCKET_ARTIFACTS }),
  entitlements: createStaticEntitlementProvider(env.DEV_ENTITLEMENTS),
  downloadTtlSeconds: env.DOWNLOAD_URL_TTL_SECONDS,
  ipHashSecret: env.IP_HASH_SECRET,
});

const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

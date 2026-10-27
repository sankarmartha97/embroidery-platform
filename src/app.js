import express from 'express';
import { authenticate } from './http/auth.js';
import { correlation } from './http/correlation.js';
import { createErrorHandler, notFoundHandler } from './http/errors.js';
import { rateLimit } from './http/rate-limit.js';
import { createArtifactsRouter } from './modules/artifacts/index.js';
import { createHealthRouter } from './modules/health/index.js';
import { createJobsRouter } from './modules/jobs/index.js';
import { createMachinesRouter } from './modules/machines/index.js';
import { createProjectsRouter } from './modules/projects/index.js';
import { createReferenceRouter } from './modules/reference/index.js';

const DOCUMENT_ROUTE = /^\/design-projects\/[^/]+\/draft$/;

/**
 * Express app factory (no listen). Dependencies are injected so tests can supply their own.
 * @param {{ db, logger, verifyToken, rolesProvider, rateLimit: { windowMs, max }, allowUngatedFormats: boolean, engineName: string,
 *   store, entitlements, downloadTtlSeconds: number, ipHashSecret: string }} deps
 */
export function createApp(deps) {
  const { db, logger, verifyToken, rolesProvider } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the load balancer
  app.use(correlation(logger));

  app.use(createHealthRouter({ db }));

  const api = express.Router();
  api.use(rateLimit({ ...deps.rateLimit, keyPrefix: 'anon' }));
  api.use(authenticate({ verifyToken, rolesProvider }));
  api.use(rateLimit({ ...deps.rateLimit, keyPrefix: 'user' }));
  // Bodies are parsed only after authentication. Project documents may be up to 10 MB
  // (07-security-licensing/input-handling.md); every other body is limited to 1 MB.
  const jsonDocument = express.json({ limit: '10mb' });
  const jsonDefault = express.json({ limit: '1mb' });
  api.use((req, res, next) =>
    (DOCUMENT_ROUTE.test(req.path) ? jsonDocument : jsonDefault)(req, res, next),
  );
  api.use(createReferenceRouter({ db, allowUngatedFormats: deps.allowUngatedFormats }));
  api.use(createMachinesRouter({ db }));
  api.use(createProjectsRouter({ db }));
  api.use(
    createJobsRouter({
      db,
      engineName: deps.engineName,
      allowUngatedFormats: deps.allowUngatedFormats,
    }),
  );
  api.use(
    createArtifactsRouter({
      db,
      store: deps.store,
      entitlements: deps.entitlements,
      ttlSeconds: deps.downloadTtlSeconds,
      ipHashSecret: deps.ipHashSecret,
    }),
  );
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

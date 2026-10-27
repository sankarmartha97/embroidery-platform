import express from 'express';
import { authenticate } from './http/auth.js';
import { correlation } from './http/correlation.js';
import { createErrorHandler, notFoundHandler } from './http/errors.js';
import { rateLimit } from './http/rate-limit.js';
import { createHealthRouter } from './modules/health/index.js';
import { createMachinesRouter } from './modules/machines/index.js';
import { createReferenceRouter } from './modules/reference/index.js';

/**
 * Express app factory (no listen). Dependencies are injected so tests can supply their own.
 * @param {{ db, logger, verifyToken, rolesProvider, rateLimit: { windowMs, max }, allowUngatedFormats: boolean }} deps
 */
export function createApp(deps) {
  const { db, logger, verifyToken, rolesProvider } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the load balancer
  app.use(correlation(logger));
  app.use(express.json({ limit: '1mb' }));

  app.use(createHealthRouter({ db }));

  const api = express.Router();
  api.use(rateLimit({ ...deps.rateLimit, keyPrefix: 'anon' }));
  api.use(authenticate({ verifyToken, rolesProvider }));
  api.use(rateLimit({ ...deps.rateLimit, keyPrefix: 'user' }));
  api.use(createReferenceRouter({ db, allowUngatedFormats: deps.allowUngatedFormats }));
  api.use(createMachinesRouter({ db }));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}

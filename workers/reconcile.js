// Scheduled entry point (every 5 minutes in deployed environments): one reconcile pass, then exit.
import { env } from '../src/config/env.js';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { createReconciler } from './reconciler.js';

const reconciler = createReconciler({
  pool,
  staleMs: env.RECONCILER_STALE_MS,
  logger: logger.child({ component: 'reconciler' }),
});
try {
  const result = await reconciler.runOnce();
  logger.info(result, 'reconcile pass finished');
} finally {
  await pool.end();
}

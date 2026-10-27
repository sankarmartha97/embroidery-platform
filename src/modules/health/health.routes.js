import { Router } from 'express';

/** Liveness and readiness probes. Mounted before authentication. */
export function createHealthRouter({ db }) {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch (err) {
      req.log.warn({ err }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}

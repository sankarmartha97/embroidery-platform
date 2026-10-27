import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createJobsService } from './jobs.service.js';

export function createJobsRouter({ db, engineName, allowUngatedFormats, limit }) {
  const router = Router();
  const service = createJobsService({ db, engineName, allowUngatedFormats });

  // Async (04-api/conventions.md): 202 + Location; clients poll GET /digitizing-jobs/{id}.
  // `limit` is the tighter job-creation bucket (SEC-T09).
  router.post('/design-projects/:id/jobs', limit, validateBody('JobCreate'), async (req, res) => {
    const { job } = await service.create(
      req.actor,
      req.params.id,
      req.body,
      req.get('Idempotency-Key'),
    );
    res.status(202).location(`${req.baseUrl}/digitizing-jobs/${job.id}`).json(job);
  });

  router.get('/digitizing-jobs/:jobId', async (req, res) => {
    res.json(await service.get(req.actor, req.params.jobId));
  });

  router.post('/digitizing-jobs/:jobId/cancel', async (req, res) => {
    res.status(202).json(await service.cancel(req.actor, req.params.jobId));
  });

  return router;
}

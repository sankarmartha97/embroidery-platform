import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createJobsService } from './jobs.service.js';

export function createJobsRouter({ db, engineName, allowUngatedFormats }) {
  const router = Router();
  const service = createJobsService({ db, engineName, allowUngatedFormats });

  // Async (04-api/conventions.md): 202 + Location; clients poll GET /digitizing-jobs/{id}.
  router.post('/design-projects/:id/jobs', validateBody('JobCreate'), async (req, res) => {
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

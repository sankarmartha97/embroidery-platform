import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createPublicationsService } from './publications.service.js';

// Inline request schemas from openapi.yaml (submitProject, reviewPublication).
const SUBMIT = {
  type: 'object',
  required: ['versionId', 'acceptCreatorTerms'],
  properties: {
    versionId: { type: 'string', format: 'uuid' },
    acceptCreatorTerms: { type: 'boolean', const: true },
  },
};
const REVIEW = {
  type: 'object',
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'reject', 'request_changes'] },
    reason: { type: 'string', maxLength: 1000 },
  },
};

export function createPublicationsRouter({ db, ipHashSecret }) {
  const router = Router();
  const service = createPublicationsService({ db, ipHashSecret });

  router.post('/design-projects/:id/submit', validateBody(SUBMIT), async (req, res) => {
    res.status(201).json(await service.submit(req.actor, req.params.id, req.body, { ip: req.ip }));
  });

  router.get('/design-projects/:id/publications', async (req, res) => {
    res.json(await service.listForProject(req.actor, req.params.id));
  });

  router.get('/design-publications', async (req, res) => {
    res.json(await service.queue(req.actor, req.query));
  });

  router.get('/design-publications/:id', async (req, res) => {
    res.json(await service.get(req.actor, req.params.id));
  });

  router.post('/design-publications/:id/review', validateBody(REVIEW), async (req, res) => {
    res.json(await service.review(req.actor, req.params.id, req.body));
  });

  return router;
}

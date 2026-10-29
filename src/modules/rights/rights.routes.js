import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createRightsService } from './rights.service.js';

// Inline request schema from openapi.yaml (verifyRights).
const VERIFICATION = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: ['verified', 'rejected', 'disputed'] } },
};

export function createRightsRouter({ db }) {
  const router = Router();
  const service = createRightsService({ db });

  router.post(
    '/design-projects/:id/rights',
    validateBody('RightsDeclaration'),
    async (req, res) => {
      res.status(201).json(await service.declare(req.actor, req.params.id, req.body));
    },
  );

  router.get('/design-projects/:id/rights', async (req, res) => {
    res.json(await service.list(req.actor, req.params.id));
  });

  router.post(
    '/design-rights/:rightsId/verification',
    validateBody(VERIFICATION),
    async (req, res) => {
      res.json(await service.verify(req.actor, req.params.rightsId, req.body));
    },
  );

  return router;
}

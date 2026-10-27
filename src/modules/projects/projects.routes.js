import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createProjectsService } from './projects.service.js';

// Inline request schema from openapi.yaml (createVersion).
const VERSION_CREATE = {
  type: 'object',
  properties: { label: { type: 'string', maxLength: 120 } },
};

const etag = (revision) => `"${revision}"`;

export function createProjectsRouter({ db }) {
  const router = Router();
  const service = createProjectsService({ db });

  router.post('/design-projects', validateBody('ProjectCreate'), async (req, res) => {
    const project = await service.create(req.actor, req.body);
    res.status(201).location(`${req.baseUrl}/design-projects/${project.id}`).json(project);
  });

  router.get('/design-projects', async (req, res) => {
    res.json(await service.list(req.actor, req.query));
  });

  router.get('/design-projects/:id', async (req, res) => {
    const project = await service.get(req.actor, req.params.id);
    res.set('ETag', etag(project.draftRevision)).json(project);
  });

  router.patch('/design-projects/:id', validateBody('ProjectUpdate'), async (req, res) => {
    res.json(await service.update(req.actor, req.params.id, req.body));
  });

  // The body is validated by the document validator (schema + cross-reference + geometry).
  router.put('/design-projects/:id/draft', async (req, res) => {
    const result = await service.saveDraft(req.actor, req.params.id, req.get('If-Match'), req.body);
    res.set('ETag', etag(result.draftRevision)).json(result);
  });

  router.post('/design-projects/:id/versions', validateBody(VERSION_CREATE), async (req, res) => {
    const { version, created } = await service.createVersion(req.actor, req.params.id, req.body);
    res.status(created ? 201 : 200).json(version);
  });

  router.get('/design-projects/:id/versions', async (req, res) => {
    res.json(await service.listVersions(req.actor, req.params.id, req.query));
  });

  return router;
}

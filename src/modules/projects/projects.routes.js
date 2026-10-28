import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createCollaboratorsService } from './collaborators.service.js';
import { createProjectsService } from './projects.service.js';

// Inline request schema from openapi.yaml (createVersion).
const VERSION_CREATE = {
  type: 'object',
  properties: { label: { type: 'string', maxLength: 120 } },
};

// Inline request schema from openapi.yaml (duplicateProject).
const DUPLICATE = {
  type: 'object',
  properties: {
    versionId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
  },
};

const etag = (revision) => `"${revision}"`;

export function createProjectsRouter({ db }) {
  const router = Router();
  const service = createProjectsService({ db });
  const collaborators = createCollaboratorsService({ db });

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

  router.post('/design-projects/:id/versions/:versionId/restore', async (req, res) => {
    const result = await service.restoreVersion(
      req.actor,
      req.params.id,
      req.params.versionId,
      req.get('If-Match'),
    );
    res.set('ETag', etag(result.draftRevision)).json(result);
  });

  router.get('/design-projects/:id/collaborators', async (req, res) => {
    res.json(await collaborators.list(req.actor, req.params.id));
  });

  router.post(
    '/design-projects/:id/collaborators',
    validateBody('CollaboratorCreate'),
    async (req, res) => {
      res.status(201).json(await collaborators.add(req.actor, req.params.id, req.body));
    },
  );

  router.patch(
    '/design-projects/:id/collaborators/:userId',
    validateBody('CollaboratorUpdate'),
    async (req, res) => {
      res.json(await collaborators.update(req.actor, req.params.id, req.params.userId, req.body));
    },
  );

  router.delete('/design-projects/:id/collaborators/:userId', async (req, res) => {
    await collaborators.revoke(req.actor, req.params.id, req.params.userId);
    res.status(204).end();
  });

  // Same key + same body → the same copy, still 201 (04-api/conventions.md).
  router.post('/design-projects/:id/duplicate', validateBody(DUPLICATE), async (req, res) => {
    const { project } = await service.duplicate(
      req.actor,
      req.params.id,
      req.body,
      req.get('Idempotency-Key'),
    );
    res.status(201).location(`${req.baseUrl}/design-projects/${project.id}`).json(project);
  });

  return router;
}

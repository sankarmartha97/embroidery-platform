import { Router } from 'express';
import { createArtifactsService } from './artifacts.service.js';

export function createArtifactsRouter({ limit, ...deps }) {
  const router = Router();
  const service = createArtifactsService(deps);

  router.get('/design-projects/:id/artifacts', async (req, res) => {
    res.json(await service.list(req.actor, req.params.id, req.query));
  });

  // `limit` is the tighter download-URL bucket (SEC-T09).
  router.post('/artifacts/:artifactId/download-url', limit, async (req, res) => {
    const result = await service.createDownloadUrl(req.actor, req.params.artifactId, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.set('Cache-Control', 'no-store').json(result);
  });

  // Artifacts are immutable, so the content hash is a strong ETag and clients may cache.
  const serve = (artifactType, headers) => async (req, res) => {
    const { body, sha256 } = await service.content(req.actor, req.params.artifactId, artifactType);
    const etag = `"${sha256}"`;
    res.set({ ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable' });
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.set(headers).send(body);
  };
  router.get(
    '/artifacts/:artifactId/stitch-data',
    serve('stitch_data', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }),
  );
  router.get(
    '/artifacts/:artifactId/report',
    serve('report', { 'Content-Type': 'application/json' }),
  );

  return router;
}

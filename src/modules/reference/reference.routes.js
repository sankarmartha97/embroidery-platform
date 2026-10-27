import { Router } from 'express';
import { availableFormats } from '../../config/formats.js';
import { createReferenceRepository } from './reference.repository.js';

export function createReferenceRouter({ db, allowUngatedFormats }) {
  const router = Router();
  const repo = createReferenceRepository(db);

  router.get('/machine-formats', (_req, res) => {
    const data = availableFormats({ allowUngated: allowUngatedFormats }).map((f) => ({
      code: f.code,
      name: f.name,
      extension: f.extension,
      colourInfo: f.colourInfo,
      maxStitchMm: f.maxStitchMm,
      productionEnabled: f.productionEnabled,
    }));
    res.json({ data });
  });

  router.get('/machine-profiles', async (req, res) => {
    res.json({ data: await repo.listMachineProfiles(req.actor.userId) });
  });

  return router;
}

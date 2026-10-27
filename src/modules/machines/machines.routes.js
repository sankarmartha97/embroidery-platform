import { Router } from 'express';
import { validateBody } from '../../http/validate.js';
import { createMachinesService } from './machines.service.js';

export function createMachinesRouter({ db }) {
  const router = Router();
  const service = createMachinesService({ db });

  router.get('/me/machines', async (req, res) => {
    res.json({ data: await service.list(req.actor) });
  });

  router.post('/me/machines', validateBody('UserMachineCreate'), async (req, res) => {
    const machine = await service.create(req.actor, req.body);
    res.status(201).json(machine);
  });

  return router;
}

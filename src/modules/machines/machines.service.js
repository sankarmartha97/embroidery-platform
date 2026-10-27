import { isKnownFormat } from '../../config/formats.js';
import { transaction } from '../../db/transaction.js';
import { errors } from '../../http/errors.js';
import { newId } from '../../lib/ids.js';
import { canManageOwnMachines } from './machines.policy.js';
import { createMachinesRepository } from './machines.repository.js';

// Placeholders from 01-product/feature-specifications.md (FS-1.1, FS-1.2).
export const MAX_MACHINES_PER_USER = 10;
export const HOOP_MIN_MM = 30;
export const HOOP_MAX_MM = 600;

/** UserMachine (openapi.yaml): `nickname` is a string when set and absent otherwise. */
function toResponse(m) {
  return {
    id: m.id,
    ...(m.nickname ? { nickname: m.nickname } : {}),
    machineBrand: m.machineBrand,
    machineModel: m.machineModel,
    preferredFormat: m.preferredFormat,
    hoops: m.hoops,
    isDefault: m.isDefault,
    machineProfileId: m.machineProfileId,
  };
}

function checkHoops(hoops) {
  const details = [];
  hoops.forEach((hoop, i) => {
    for (const side of ['widthMm', 'heightMm']) {
      if (hoop[side] < HOOP_MIN_MM || hoop[side] > HOOP_MAX_MM) {
        details.push({
          path: `/hoops/${i}/${side}`,
          issue: `must be between ${HOOP_MIN_MM} and ${HOOP_MAX_MM} mm`,
        });
      }
    }
  });
  if (details.length) throw errors.validation(details);
}

export function createMachinesService({ db }) {
  return {
    async list(actor) {
      if (!canManageOwnMachines(actor)) throw errors.forbidden();
      const machines = await createMachinesRepository(db).listByUser(actor.userId);
      return machines.map(toResponse);
    },

    async create(actor, input) {
      if (!canManageOwnMachines(actor)) throw errors.forbidden();
      if (!isKnownFormat(input.preferredFormat))
        throw errors.unsupportedFormat(input.preferredFormat);
      checkHoops(input.hoops);

      return transaction(db, async (conn) => {
        const repo = createMachinesRepository(conn);
        const count = await repo.countByUserForUpdate(actor.userId);
        if (count >= MAX_MACHINES_PER_USER) {
          throw errors.validation(
            [
              {
                path: '/',
                issue: `a user can register at most ${MAX_MACHINES_PER_USER} machines`,
              },
            ],
            'Machine limit reached.',
          );
        }
        const isDefault = input.isDefault === true || count === 0;
        if (isDefault) await repo.clearDefault(actor.userId);

        const machine = {
          id: newId(),
          userId: actor.userId,
          nickname: input.nickname ?? null,
          machineBrand: input.machineBrand.trim(),
          machineModel: input.machineModel.trim(),
          preferredFormat: input.preferredFormat,
          hoops: input.hoops.map((h) => ({
            name: h.name,
            widthMm: h.widthMm,
            heightMm: h.heightMm,
          })),
          machineProfileId: null,
          isDefault,
        };
        await repo.insert(machine);
        return toResponse(machine);
      });
    },
  };
}

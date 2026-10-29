import { errors } from '../../http/errors.js';
import { newId } from '../../lib/ids.js';
import {
  canManageRights,
  canSubmit,
  findProjectAccess,
  listProjectAssetIds,
  loadReadableProject,
} from '../projects/index.js';
import { createRightsRepository } from './rights.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED_STATUSES = new Set(['in_review', 'published', 'archived']);

/**
 * Which declarations a submission still needs (FS-6.3, BR-02): one for the design and one for
 * every imported asset. Rejected declarations do not count.
 * @returns {Array<{ path: string, issue: string }>} empty when complete
 */
export function missingRights(rights, assetIds) {
  const usable = rights.filter((r) => r.verificationStatus !== 'rejected');
  const missing = [];
  if (!usable.some((r) => r.assetId === null)) {
    missing.push({ path: '/rights', issue: 'the design needs a rights declaration' });
  }
  for (const assetId of assetIds) {
    if (!usable.some((r) => r.assetId === assetId)) {
      missing.push({ path: `/assets/${assetId}`, issue: 'needs a rights declaration' });
    }
  }
  return missing;
}

/** Field rules beyond the schema: who holds the rights and where they come from. */
function checkDeclaration(input) {
  const details = [];
  const needs = (field) =>
    !input[field]?.trim() && details.push({ path: `/${field}`, issue: 'is required' });
  if (input.rightsType === 'licensed' || input.rightsType === 'commissioned') {
    needs('rightsHolderName');
    needs('sourceReference');
  }
  if (input.rightsType === 'public_domain') needs('sourceReference');
  if (details.length) throw errors.validation(details, 'The rights declaration is incomplete.');
}

export function createRightsService({ db }) {
  return {
    /** Owner only: declaring rights is part of submitting (04-api/authorization.md). */
    async declare(actor, projectId, input) {
      const { project } = await loadReadableProject(db, actor, projectId);
      if (!canSubmit(actor, project)) throw errors.forbidden();
      if (CLOSED_STATUSES.has(project.status)) {
        throw errors.invalidState('Rights can only be declared while the project is a draft.');
      }
      checkDeclaration(input);
      if (input.assetId && !(await listProjectAssetIds(db, projectId)).includes(input.assetId)) {
        throw errors.validation([{ path: '/assetId', issue: 'is not an asset of this project' }]);
      }
      const record = { ...input, id: newId(), projectId, declaredBy: actor.userId };
      const repo = createRightsRepository(db);
      await repo.insert(record);
      return repo.findById(record.id);
    },

    async list(actor, projectId) {
      await loadReadableProject(db, actor, projectId);
      const rows = await createRightsRepository(db).listByProject(projectId);
      return { data: rows };
    },

    /** staff.rights_admin records a verification decision; audited (FR-24). */
    async verify(actor, rightsId, { status }) {
      if (!canManageRights(actor)) throw errors.forbidden();
      const repo = createRightsRepository(db);
      const record = UUID.test(rightsId) && (await repo.findById(rightsId));
      if (!record || !(await findProjectAccess(db, actor, record.projectId))) {
        throw errors.notFound();
      }
      await repo.setVerification(rightsId, status, actor.userId);
      actor.audit?.('rights.verification', {
        rightsId,
        projectId: record.projectId,
        from: record.verificationStatus,
        to: status,
      });
      return repo.findById(rightsId);
    },
  };
}

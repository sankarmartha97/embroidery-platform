import { transaction } from '../../db/transaction.js';
import { errors } from '../../http/errors.js';
import { newId } from '../../lib/ids.js';
import { createCollaboratorsRepository } from './collaborators.repository.js';
import { loadReadableWith, UUID } from './projects.access.js';
import { canManageCollaborators } from './projects.policy.js';
import { createProjectsRepository } from './projects.repository.js';

function toResponse(c) {
  return {
    userId: c.userId,
    role: c.role,
    canExport: c.canExport,
    invitedBy: c.invitedBy,
    createdAt: c.createdAt,
  };
}

// The users FK rejects an id the marketplace does not know.
const isUnknownUser = (err) => err?.code === 'ER_NO_REFERENCED_ROW_2';

/** Sharing (FS-7.10, S8-04). Only the owner manages collaborators; others who can read get 403. */
export function createCollaboratorsService({ db }) {
  async function loadManaged(conn, actor, projectId, options) {
    const { project } = await loadReadableWith(
      createProjectsRepository(conn),
      actor,
      projectId,
      options,
    );
    if (!canManageCollaborators(actor, project)) throw errors.forbidden();
    return project;
  }

  return {
    async list(actor, projectId) {
      await loadManaged(db, actor, projectId);
      const rows = await createCollaboratorsRepository(db).listActive(projectId);
      return { data: rows.map(toResponse) };
    },

    async add(actor, projectId, { userId, role, canExport = false }) {
      return transaction(db, async (conn) => {
        // Lock the project row: serialises invites for this project.
        const project = await loadManaged(conn, actor, projectId, { forUpdate: true });
        if (userId === project.ownerUserId) {
          throw errors.validation([{ path: '/userId', issue: 'is the project owner' }]);
        }
        const repo = createCollaboratorsRepository(conn);
        const existing = await repo.find(projectId, userId, { forUpdate: true });
        if (existing && !existing.revokedAt) {
          throw errors.invalidState('This user is already a collaborator.');
        }
        const invite = { projectId, userId, role, canExport, invitedBy: actor.userId };
        try {
          if (existing) await repo.reactivate(invite);
          else await repo.insert({ ...invite, id: newId() });
        } catch (err) {
          if (isUnknownUser(err)) {
            throw errors.validation([{ path: '/userId', issue: 'is not a known user' }]);
          }
          throw err;
        }
        return toResponse(await repo.find(projectId, userId));
      });
    },

    async update(actor, projectId, userId, changes) {
      await loadManaged(db, actor, projectId);
      const repo = createCollaboratorsRepository(db);
      const current = UUID.test(userId) && (await repo.find(projectId, userId));
      if (!current || current.revokedAt) throw errors.notFound();
      await repo.update(projectId, userId, changes);
      return toResponse(await repo.find(projectId, userId));
    },

    /** Takes effect on the collaborator's next request: every check reads revoked_at. */
    async revoke(actor, projectId, userId) {
      await loadManaged(db, actor, projectId);
      const revoked =
        UUID.test(userId) && (await createCollaboratorsRepository(db).revoke(projectId, userId));
      if (!revoked) throw errors.notFound();
    },
  };
}

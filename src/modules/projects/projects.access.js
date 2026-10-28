import { errors } from '../../http/errors.js';
import { canReadProject, isStaff } from './projects.policy.js';
import { createProjectsRepository } from './projects.repository.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authorization step 3: the object-level read check. Anything the caller cannot see is 404,
 * so the response never reveals whether a project exists.
 * @returns {Promise<{ project, collaborator }>}
 */
export async function loadReadableWith(repo, actor, id, options) {
  if (!UUID.test(id)) throw errors.notFound();
  const project = await repo.findById(id, options);
  if (!project) throw errors.notFound();
  const collaborator = await repo.findCollaborator(id, actor.userId);
  if (!canReadProject(actor, project, collaborator)) throw errors.notFound();
  const ownAccess =
    project.ownerUserId === actor.userId || (collaborator && !collaborator.revokedAt);
  if (!ownAccess && isStaff(actor)) {
    // Staff access to other users' projects is audited (07-security-licensing/permissions.md).
    actor.audit?.('staff.project_access', { projectId: id, ownerUserId: project.ownerUserId });
  }
  return { project, collaborator };
}

/** Same check for other modules, on a pool or a transaction connection. */
export function loadReadableProject(db, actor, id, options) {
  return loadReadableWith(createProjectsRepository(db), actor, id, options);
}

/** Project and the caller's collaborator row without the read check (download decisions). */
export async function findProjectAccess(db, actor, id) {
  const repo = createProjectsRepository(db);
  const project = await repo.findById(id);
  if (!project) return null;
  return { project, collaborator: await repo.findCollaborator(id, actor.userId) };
}

/** Publication workflow (publications module), on a pool or a transaction connection. */
export function setProjectState(db, id, state) {
  return createProjectsRepository(db).setState(id, state);
}

export function listProjectAssetIds(db, projectId) {
  return createProjectsRepository(db).listAssetIds(projectId);
}

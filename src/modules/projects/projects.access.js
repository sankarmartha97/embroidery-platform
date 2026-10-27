import { errors } from '../../http/errors.js';
import { canReadProject } from './projects.policy.js';
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
  return { project, collaborator };
}

/** Same check for other modules, on a pool or a transaction connection. */
export function loadReadableProject(db, actor, id, options) {
  return loadReadableWith(createProjectsRepository(db), actor, id, options);
}

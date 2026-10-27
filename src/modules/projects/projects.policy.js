// Object-level rules from 04-api/authorization.md, implemented once.
// Callers map a failed read check to 404 NOT_FOUND (don't reveal existence) and a failed
// action check on a readable object to 403 FORBIDDEN.
//
// Shapes:
//   actor        { userId, roles: Set<string> }
//   project      { id, ownerUserId, status }
//   collaborator { userId, role: 'editor' | 'viewer', canExport, revokedAt } | null
//   artifact     { artifactType: 'source' | 'stitch_data' | 'preview' | 'machine_file' | 'report' }
//   entitlement  { current: boolean } | null   (from the existing marketplace, OQ-04)

const DIGITIZE_ROLES = ['designer', 'staff.designer'];

export function isStaff(actor) {
  for (const role of actor?.roles ?? []) if (role.startsWith('staff.')) return true;
  return false;
}

function hasRole(actor, role) {
  return Boolean(actor?.roles?.has(role));
}

function isOwner(actor, project) {
  return Boolean(actor?.userId) && project?.ownerUserId === actor.userId;
}

function activeCollaborator(actor, collaborator) {
  return Boolean(
    collaborator &&
    actor?.userId &&
    collaborator.userId === actor.userId &&
    !collaborator.revokedAt,
  );
}

/** owner · active collaborator · staff with staff.* */
export function canReadProject(actor, project, collaborator) {
  return isOwner(actor, project) || activeCollaborator(actor, collaborator) || isStaff(actor);
}

/** owner · collaborator editor · staff.designer */
export function canEditDraft(actor, project, collaborator) {
  return (
    isOwner(actor, project) ||
    (activeCollaborator(actor, collaborator) && collaborator.role === 'editor') ||
    hasRole(actor, 'staff.designer')
  );
}

/** can edit AND has the designer/staff digitize permission */
export function canCreateJob(actor, project, collaborator) {
  return (
    canEditDraft(actor, project, collaborator) && DIGITIZE_ROLES.some((r) => hasRole(actor, r))
  );
}

/** can create jobs AND (owner or collaborator with can_export) */
export function canCreateExport(actor, project, collaborator) {
  if (!canCreateJob(actor, project, collaborator)) return false;
  return (
    isOwner(actor, project) ||
    (activeCollaborator(actor, collaborator) && collaborator.canExport === true) ||
    hasRole(actor, 'staff.designer')
  );
}

/**
 * owner/collaborator · staff · customer with a current entitlement to the published design
 * (machine files and previews only).
 */
export function canDownloadArtifact(actor, project, collaborator, artifact, entitlement) {
  if (canReadProject(actor, project, collaborator)) return true;
  const customerTypes = new Set(['machine_file', 'preview']);
  return (
    Boolean(actor?.userId) &&
    project?.status === 'published' &&
    customerTypes.has(artifact?.artifactType) &&
    entitlement?.current === true
  );
}

export function canSubmit(actor, project) {
  return isOwner(actor, project);
}

export function canReview(actor) {
  return hasRole(actor, 'staff.moderator');
}

export function canManageRights(actor) {
  return hasRole(actor, 'staff.rights_admin');
}

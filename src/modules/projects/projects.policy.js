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

/** Role check (authorization step 2): registered designers and staff.designer; not customers. */
export function canCreateProject(actor) {
  return DIGITIZE_ROLES.some((r) => hasRole(actor, r));
}

/** Sharing is the owner's decision: visibility and collaborators. */
export function canManageCollaborators(actor, project) {
  return isOwner(actor, project);
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
 * Download decision (04-api/authorization.md): owner · staff · collaborator "per above" (machine
 * files need the export permission, like export jobs) · customer with a current entitlement to
 * the published design (machine files and previews of the published version only).
 * `project.publishedVersionId` is the version of the approved publication, or null.
 * @returns {{ allowed: boolean, basis: 'owner'|'staff'|'collaborator'|'purchase'|'subscription'|'none', reason?: string }}
 */
export function downloadDecision(actor, project, collaborator, artifact, entitlement) {
  if (isOwner(actor, project)) return { allowed: true, basis: 'owner' };
  if (activeCollaborator(actor, collaborator)) {
    if (artifact?.artifactType === 'machine_file' && collaborator.canExport !== true) {
      return { allowed: false, basis: 'collaborator', reason: 'EXPORT_NOT_ALLOWED' };
    }
    return { allowed: true, basis: 'collaborator' };
  }
  if (isStaff(actor)) return { allowed: true, basis: 'staff' };

  const customerTypes = new Set(['machine_file', 'preview']);
  const onSale =
    project?.status === 'published' &&
    Boolean(project.publishedVersionId) &&
    artifact?.projectVersionId === project.publishedVersionId &&
    customerTypes.has(artifact?.artifactType);
  if (!actor?.userId || !onSale) return { allowed: false, basis: 'none', reason: 'NOT_VISIBLE' };
  if (entitlement?.current !== true) {
    return { allowed: false, basis: 'none', reason: 'ENTITLEMENT_REQUIRED' };
  }
  return {
    allowed: true,
    basis: entitlement.basis === 'subscription' ? 'subscription' : 'purchase',
  };
}

export function canDownloadArtifact(actor, project, collaborator, artifact, entitlement) {
  return downloadDecision(actor, project, collaborator, artifact, entitlement).allowed;
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

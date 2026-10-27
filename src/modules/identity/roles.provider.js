// Roles are loaded server-side and never trusted from token claims (04-api/authentication.md).
// The real source is the existing marketplace's user/role data (assumption A5). Until it is
// connected, this provider assigns roles from configuration (DEV_ROLE_ASSIGNMENTS, empty in prod).

export const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  DESIGNER: 'designer',
  STAFF_DESIGNER: 'staff.designer',
  STAFF_MODERATOR: 'staff.moderator',
  STAFF_RIGHTS_ADMIN: 'staff.rights_admin',
  STAFF_ADMIN: 'staff.admin',
});

const KNOWN = new Set(Object.values(ROLES));

export function createStaticRolesProvider(assignments = {}) {
  return {
    async getRoles(userId) {
      const extra = (assignments[userId] ?? []).filter((r) => KNOWN.has(r));
      return [ROLES.CUSTOMER, ...extra];
    },
  };
}

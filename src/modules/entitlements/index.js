// Entitlements belong to the existing marketplace; this platform only reads them (OQ-04).
// Until the integration (S10-01) a static stub answers from DEV_ENTITLEMENTS, empty in production.
//
// Provider contract:
//   getEntitlement(userId, { projectId, listingRef })
//     → { current: true, basis: 'purchase' | 'subscription', ref: string } | null

export function createStaticEntitlementProvider(grants = {}) {
  return {
    async getEntitlement(userId, { projectId }) {
      const grant = (grants[userId] ?? []).find((g) => g.projectId === projectId);
      if (!grant || !['purchase', 'subscription'].includes(grant.basis)) return null;
      return { current: true, basis: grant.basis, ref: grant.ref ?? null };
    },
  };
}

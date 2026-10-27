// design_export_events: every download decision, allowed and denied (SEC-T03). Append-only.

export function createExportEventsRepository(db) {
  return {
    async insert(e) {
      await db.execute(
        `INSERT INTO design_export_events
           (artifact_id, user_id, decision, basis, reason_code, entitlement_ref, url_expires_at,
            client_ip_hash, user_agent, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          e.artifactId,
          e.userId,
          e.decision,
          e.basis,
          e.reasonCode ?? null,
          e.entitlementRef ?? null,
          e.urlExpiresAt ?? null,
          e.clientIpHash ?? null,
          e.userAgent ? String(e.userAgent).slice(0, 300) : null,
          e.correlationId ? String(e.correlationId).slice(0, 64) : null,
        ],
      );
    },
  };
}

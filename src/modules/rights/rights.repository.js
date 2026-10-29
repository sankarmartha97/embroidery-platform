// design_rights: one row per declaration. A design-level declaration has asset_id NULL.
// design_license_acceptances: creator terms accepted at submission.

const COLUMNS = `id, project_id, asset_id, declared_by, rights_holder_name, rights_type,
  source_reference, license_terms_version, commercial_use_allowed, modification_allowed,
  redistribution_allowed, verification_status, verified_by, verified_at, created_at`;

function toRights(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    rightsType: row.rights_type,
    rightsHolderName: row.rights_holder_name,
    sourceReference: row.source_reference,
    licenseTermsVersion: row.license_terms_version,
    commercialUseAllowed: Boolean(row.commercial_use_allowed),
    modificationAllowed: Boolean(row.modification_allowed),
    redistributionAllowed: Boolean(row.redistribution_allowed),
    declaredBy: row.declared_by,
    verificationStatus: row.verification_status,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
  };
}

export function createRightsRepository(db) {
  return {
    async insert(r) {
      await db.execute(
        `INSERT INTO design_rights
           (id, project_id, asset_id, declared_by, rights_holder_name, rights_type,
            source_reference, license_terms_version, commercial_use_allowed,
            modification_allowed, redistribution_allowed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.projectId,
          r.assetId ?? null,
          r.declaredBy,
          r.rightsHolderName ?? null,
          r.rightsType,
          r.sourceReference ?? null,
          r.licenseTermsVersion ?? null,
          r.commercialUseAllowed ?? false,
          r.modificationAllowed ?? false,
          r.redistributionAllowed ?? false,
        ],
      );
    },

    async findById(id) {
      const [rows] = await db.execute(`SELECT ${COLUMNS} FROM design_rights WHERE id = ?`, [id]);
      return rows[0] ? toRights(rows[0]) : null;
    },

    /** Oldest first, so the history of declarations reads in order. */
    async listByProject(projectId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_rights WHERE project_id = ? ORDER BY created_at, id`,
        [projectId],
      );
      return rows.map(toRights);
    },

    /** FS-6.3 attestation: who accepted which terms, when, from which (hashed) IP. */
    async recordCreatorTerms({ id, userId, projectId, termsVersion, clientIpHash }) {
      await db.execute(
        `INSERT INTO design_license_acceptances
           (id, user_id, license_terms_version, project_id, entitlement_type, client_ip_hash)
         VALUES (?, ?, ?, ?, 'creator_terms', ?)`,
        [id, userId, termsVersion, projectId, clientIpHash],
      );
    },

    async setVerification(id, status, verifiedBy) {
      await db.execute(
        `UPDATE design_rights
            SET verification_status = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP(3)
          WHERE id = ?`,
        [status, verifiedBy, id],
      );
    },
  };
}

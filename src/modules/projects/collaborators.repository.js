// design_collaborators. One row per (project, user); revoking sets revoked_at, re-inviting
// clears it, so access history stays in one place.

const COLUMNS = 'user_id, role, can_export, invited_by, created_at, revoked_at';

function toCollaborator(row) {
  return {
    userId: row.user_id,
    role: row.role,
    canExport: Boolean(row.can_export),
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function createCollaboratorsRepository(db) {
  return {
    /** Active collaborators, oldest invite first. */
    async listActive(projectId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_collaborators
          WHERE project_id = ? AND revoked_at IS NULL
          ORDER BY created_at, user_id`,
        [projectId],
      );
      return rows.map(toCollaborator);
    },

    /** The row whether active or revoked, or null. */
    async find(projectId, userId, { forUpdate = false } = {}) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_collaborators
          WHERE project_id = ? AND user_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
        [projectId, userId],
      );
      return rows[0] ? toCollaborator(rows[0]) : null;
    },

    async insert({ id, projectId, userId, role, canExport, invitedBy }) {
      await db.execute(
        `INSERT INTO design_collaborators (id, project_id, user_id, role, can_export, invited_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, projectId, userId, role, canExport, invitedBy],
      );
    },

    /** Re-invite: a fresh invitation on the existing row. */
    async reactivate({ projectId, userId, role, canExport, invitedBy }) {
      await db.execute(
        `UPDATE design_collaborators
            SET role = ?, can_export = ?, invited_by = ?, revoked_at = NULL,
                created_at = CURRENT_TIMESTAMP(3)
          WHERE project_id = ? AND user_id = ?`,
        [role, canExport, invitedBy, projectId, userId],
      );
    },

    async update(projectId, userId, changes) {
      const sets = [];
      const params = [];
      if ('role' in changes) {
        sets.push('role = ?');
        params.push(changes.role);
      }
      if ('canExport' in changes) {
        sets.push('can_export = ?');
        params.push(changes.canExport);
      }
      if (sets.length === 0) return;
      await db.execute(
        `UPDATE design_collaborators SET ${sets.join(', ')}
          WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL`,
        [...params, projectId, userId],
      );
    },

    /** @returns {Promise<boolean>} false if there was no active row */
    async revoke(projectId, userId) {
      const [res] = await db.execute(
        `UPDATE design_collaborators SET revoked_at = CURRENT_TIMESTAMP(3)
          WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL`,
        [projectId, userId],
      );
      return res.affectedRows === 1;
    },
  };
}

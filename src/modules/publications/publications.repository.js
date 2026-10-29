// design_publications: one row per submission. The open submission of a project is the one in
// 'submitted' or 'in_review'.

const COLUMNS = `p.id, p.project_id, p.project_version_id, p.submitted_by, p.status,
  p.reviewer_user_id, p.decision_reason, p.submitted_at, p.decided_at`;
const OPEN = `('submitted', 'in_review')`;

function toPublication(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectVersionId: row.project_version_id,
    submittedBy: row.submitted_by,
    status: row.status,
    reviewerUserId: row.reviewer_user_id,
    decisionReason: row.decision_reason,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
  };
}

export function createPublicationsRepository(db) {
  return {
    async insert(p) {
      await db.execute(
        `INSERT INTO design_publications (id, project_id, project_version_id, submitted_by)
         VALUES (?, ?, ?, ?)`,
        [p.id, p.projectId, p.projectVersionId, p.submittedBy],
      );
    },

    async findById(id, { forUpdate = false } = {}) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_publications p WHERE p.id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
        [id],
      );
      return rows[0] ? toPublication(rows[0]) : null;
    },

    async findOpen(projectId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_publications p
          WHERE p.project_id = ? AND p.status IN ${OPEN} LIMIT 1`,
        [projectId],
      );
      return rows[0] ? toPublication(rows[0]) : null;
    },

    /** Newest first. */
    async listByProject(projectId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_publications p
          WHERE p.project_id = ? ORDER BY p.submitted_at DESC, p.id DESC`,
        [projectId],
      );
      return rows.map(toPublication);
    },

    /** Moderation queue: oldest first (SLA order), keyset on (submitted_at, id). */
    async listByStatus({ status, after, limit }) {
      const params = [status];
      let where = 'p.status = ?';
      if (after) {
        where += ' AND (p.submitted_at > ? OR (p.submitted_at = ? AND p.id > ?))';
        params.push(after.submittedAt, after.submittedAt, after.id);
      }
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_publications p
          WHERE ${where} ORDER BY p.submitted_at, p.id LIMIT ${Number(limit)}`,
        params,
      );
      return rows.map(toPublication);
    },

    async decide(id, { status, reviewerUserId, reason }) {
      await db.execute(
        `UPDATE design_publications
            SET status = ?, reviewer_user_id = ?, decision_reason = ?,
                decided_at = CURRENT_TIMESTAMP(3),
                published_at = IF(? = 'approved', CURRENT_TIMESTAMP(3), published_at)
          WHERE id = ?`,
        [status, reviewerUserId, reason ?? null, status, id],
      );
    },
  };
}

// design_project_versions: immutable snapshots. Rows are only ever inserted.

const COLUMNS = `id, project_id, version_number, document_schema_version, document_sha256,
  label, reason, created_by, created_at`;

function toVersion(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    documentSchemaVersion: row.document_schema_version,
    documentSha256: row.document_sha256,
    label: row.label,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createVersionsRepository(db) {
  return {
    async latest(projectId) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_project_versions
          WHERE project_id = ? ORDER BY version_number DESC LIMIT 1`,
        [projectId],
      );
      return rows[0] ? toVersion(rows[0]) : null;
    },

    async insert(version) {
      await db.execute(
        `INSERT INTO design_project_versions
           (id, project_id, version_number, document_schema_version, document_json,
            document_sha256, label, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          version.id,
          version.projectId,
          version.versionNumber,
          version.documentSchemaVersion,
          version.documentJson,
          version.documentSha256,
          version.label ?? null,
          version.reason,
          version.createdBy,
          version.createdAt,
        ],
      );
    },

    /** Newest first; keyset pagination on version_number. */
    async list(projectId, { beforeNumber, limit }) {
      const params = [projectId];
      let where = 'project_id = ?';
      if (beforeNumber) {
        where += ' AND version_number < ?';
        params.push(beforeNumber);
      }
      const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM design_project_versions
          WHERE ${where} ORDER BY version_number DESC LIMIT ${Number(limit)}`,
        params,
      );
      return rows.map(toVersion);
    },

    /** The version with its document, for workers. */
    async findWithDocument(id) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS}, document_json FROM design_project_versions WHERE id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      const doc = rows[0].document_json;
      return {
        ...toVersion(rows[0]),
        document: typeof doc === 'string' ? JSON.parse(doc) : doc,
      };
    },
  };
}

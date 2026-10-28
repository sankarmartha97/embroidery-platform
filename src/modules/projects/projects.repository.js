// design_projects and design_collaborators. Soft-deleted projects are invisible here.

const COLUMNS = `p.id, p.owner_user_id, p.title, p.description, p.visibility, p.status,
  p.draft_revision, p.current_version_id, p.machine_profile_id, p.created_at, p.updated_at`;

function parseJson(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toProject(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    draftRevision: row.draft_revision,
    currentVersionId: row.current_version_id,
    machineProfileId: row.machine_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCollaborator(row) {
  return {
    userId: row.user_id,
    role: row.role,
    canExport: Boolean(row.can_export),
    revokedAt: row.revoked_at,
  };
}

export function createProjectsRepository(db) {
  return {
    async insert(project) {
      await db.execute(
        `INSERT INTO design_projects
           (id, owner_user_id, title, description, machine_profile_id,
            draft_document_json, draft_schema_version, draft_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          project.id,
          project.ownerUserId,
          project.title,
          project.description ?? null,
          project.machineProfileId ?? null,
          JSON.stringify(project.draft),
          project.draft.schemaVersion,
        ],
      );
    },

    /** A copy of another project; it starts at draft revision 0 like any new project. */
    async insertDuplicate(project) {
      await db.execute(
        `INSERT INTO design_projects
           (id, owner_user_id, title, description, machine_profile_id,
            draft_document_json, draft_schema_version, draft_revision,
            duplicated_from_project_id, duplicate_idempotency_key, duplicate_request_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [
          project.id,
          project.ownerUserId,
          project.title,
          project.description ?? null,
          project.machineProfileId ?? null,
          JSON.stringify(project.draft),
          project.draft.schemaVersion,
          project.duplicatedFromProjectId,
          project.idempotencyKey ?? null,
          project.requestSha256 ?? null,
        ],
      );
    },

    /**
     * The caller's copy made with this Idempotency-Key, or null (keys are per user). Deleted
     * copies count too: the unique key still holds the key.
     */
    async findByDuplicateKey(ownerUserId, key) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS}, p.duplicate_request_sha256
           FROM design_projects p
          WHERE p.owner_user_id = ? AND p.duplicate_idempotency_key = ?`,
        [ownerUserId, key],
      );
      if (!rows[0]) return null;
      return { ...toProject(rows[0]), requestSha256: rows[0].duplicate_request_sha256 };
    },

    /** @param {{ withDraft?: boolean, forUpdate?: boolean }} options */
    async findById(id, { withDraft = false, forUpdate = false } = {}) {
      const [rows] = await db.execute(
        `SELECT ${COLUMNS}${withDraft ? ', p.draft_document_json' : ''}
           FROM design_projects p
          WHERE p.id = ? AND p.deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
        [id],
      );
      if (!rows[0]) return null;
      const project = toProject(rows[0]);
      if (withDraft) project.draft = parseJson(rows[0].draft_document_json);
      return project;
    },

    async findCollaborator(projectId, userId) {
      const [rows] = await db.execute(
        `SELECT user_id, role, can_export, revoked_at
           FROM design_collaborators WHERE project_id = ? AND user_id = ?`,
        [projectId, userId],
      );
      return rows[0] ? toCollaborator(rows[0]) : null;
    },

    /**
     * Projects the user owns or collaborates on (active), newest first.
     * Keyset pagination on (updated_at, id).
     */
    async listVisible({ userId, scope, status, after, limit }) {
      const where = ['p.deleted_at IS NULL'];
      const params = [userId];
      if (scope === 'owned') where.push('p.owner_user_id = ?');
      else if (scope === 'shared') where.push('c.id IS NOT NULL AND p.owner_user_id <> ?');
      else where.push('(p.owner_user_id = ? OR c.id IS NOT NULL)');
      params.push(userId);
      if (status) {
        where.push('p.status = ?');
        params.push(status);
      }
      if (after) {
        where.push('(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))');
        params.push(after.updatedAt, after.updatedAt, after.id);
      }
      const [rows] = await db.execute(
        `SELECT ${COLUMNS}
           FROM design_projects p
           LEFT JOIN design_collaborators c
             ON c.project_id = p.id AND c.user_id = ? AND c.revoked_at IS NULL
          WHERE ${where.join(' AND ')}
          ORDER BY p.updated_at DESC, p.id DESC
          LIMIT ${Number(limit)}`,
        params,
      );
      return rows.map(toProject);
    },

    async updateMetadata(id, changes) {
      const columns = {
        title: 'title',
        description: 'description',
        visibility: 'visibility',
        machineProfileId: 'machine_profile_id',
      };
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries(columns)) {
        if (key in changes) {
          sets.push(`${column} = ?`);
          params.push(changes[key]);
        }
      }
      if (sets.length === 0) return;
      await db.execute(`UPDATE design_projects SET ${sets.join(', ')} WHERE id = ?`, [
        ...params,
        id,
      ]);
    },

    /**
     * Optimistic concurrency: writes only if the stored revision still equals `expectedRevision`.
     * @returns {Promise<boolean>} false on a stale revision
     */
    async saveDraft(id, expectedRevision, document) {
      const [res] = await db.execute(
        `UPDATE design_projects
            SET draft_document_json = ?, draft_schema_version = ?,
                draft_revision = draft_revision + 1
          WHERE id = ? AND draft_revision = ? AND deleted_at IS NULL`,
        [JSON.stringify(document), document.schemaVersion, id, expectedRevision],
      );
      return res.affectedRows === 1;
    },

    async setCurrentVersion(id, versionId) {
      await db.execute(`UPDATE design_projects SET current_version_id = ? WHERE id = ?`, [
        versionId,
        id,
      ]);
    },
  };
}

import { transaction } from '../../db/transaction.js';
import { errors } from '../../http/errors.js';
import { decodeCursor, parseEnum, parseLimit, toPage } from '../../http/pagination.js';
import {
  canonicalize,
  emptyDocument,
  validateDocument,
} from '../../lib/document/validate-document.js';
import { newId } from '../../lib/ids.js';
import { createReferenceRepository } from '../reference/index.js';
import {
  canCreateExport,
  canCreateProject,
  canEditDraft,
  canManageCollaborators,
  canReadProject,
  canSubmit,
} from './projects.policy.js';
import { createProjectsRepository } from './projects.repository.js';
import { createVersionsRepository } from './versions.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['draft', 'in_review', 'published', 'archived'];
const SCOPES = ['owned', 'shared', 'all'];

function toResponse(p) {
  return {
    id: p.id,
    ownerUserId: p.ownerUserId,
    title: p.title,
    description: p.description,
    visibility: p.visibility,
    status: p.status,
    currentVersionId: p.currentVersionId,
    machineProfileId: p.machineProfileId,
    draftRevision: p.draftRevision,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function assertEditableState(project) {
  if (project.status === 'archived') throw errors.invalidState('Archived projects are read-only.');
}

function parseIfMatch(header) {
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(header ?? '');
  if (!m) throw errors.badRequest('If-Match header with the current draftRevision is required.');
  return Number(m[1]);
}

export function createProjectsService({ db }) {
  /**
   * Authorization step 3: the object-level read check. Anything the caller cannot see is 404,
   * so the response never reveals whether a project exists.
   */
  async function loadReadable(repo, actor, id, options) {
    if (!UUID.test(id)) throw errors.notFound();
    const project = await repo.findById(id, options);
    if (!project) throw errors.notFound();
    const collaborator = await repo.findCollaborator(id, actor.userId);
    if (!canReadProject(actor, project, collaborator)) throw errors.notFound();
    return { project, collaborator };
  }

  async function assertUsableProfile(conn, actor, machineProfileId) {
    if (!machineProfileId) return null;
    const profile = await createReferenceRepository(conn).findMachineProfile(
      machineProfileId,
      actor.userId,
    );
    if (!profile) {
      throw errors.validation([
        { path: '/machineProfileId', issue: 'is not an available machine profile' },
      ]);
    }
    return profile;
  }

  return {
    async create(actor, input) {
      if (!canCreateProject(actor)) throw errors.forbidden();
      const profile = await assertUsableProfile(db, actor, input.machineProfileId);
      const project = {
        id: newId(),
        ownerUserId: actor.userId,
        title: input.title.trim(),
        description: input.description ?? null,
        machineProfileId: profile?.id ?? null,
        draft: emptyDocument(
          profile ? { width: profile.hoopWidthMm, height: profile.hoopHeightMm } : undefined,
        ),
      };
      const repo = createProjectsRepository(db);
      await repo.insert(project);
      return toResponse(await repo.findById(project.id));
    },

    async list(actor, query) {
      const limit = parseLimit(query.limit);
      const scope = parseEnum('scope', query.scope, SCOPES, 'all');
      const status = parseEnum('status', query.status, STATUSES, undefined);
      const after = decodeCursor(
        query.cursor,
        (k) => typeof k?.u === 'string' && !Number.isNaN(Date.parse(k.u)) && UUID.test(k?.i),
      );
      const rows = await createProjectsRepository(db).listVisible({
        userId: actor.userId,
        scope,
        status,
        after: after && { updatedAt: new Date(after.u), id: after.i },
        limit: limit + 1,
      });
      const page = toPage(rows, limit, (p) => ({ u: p.updatedAt.toISOString(), i: p.id }));
      return { data: page.data.map(toResponse), page: page.page };
    },

    async get(actor, id) {
      const repo = createProjectsRepository(db);
      const { project, collaborator } = await loadReadable(repo, actor, id, { withDraft: true });
      return {
        ...toResponse(project),
        draft: project.draft,
        permissions: {
          canEdit: canEditDraft(actor, project, collaborator),
          canExport: canCreateExport(actor, project, collaborator),
          canSubmit: canSubmit(actor, project),
          canManageCollaborators: canManageCollaborators(actor, project),
        },
      };
    },

    async update(actor, id, changes) {
      return transaction(db, async (conn) => {
        const repo = createProjectsRepository(conn);
        const { project, collaborator } = await loadReadable(repo, actor, id, { forUpdate: true });
        if (!canEditDraft(actor, project, collaborator)) throw errors.forbidden();
        assertEditableState(project);

        if ('visibility' in changes) {
          if (!canManageCollaborators(actor, project)) throw errors.forbidden();
          if (project.visibility === 'marketplace') {
            throw errors.invalidState(
              'Visibility of a published design changes only through publication.',
            );
          }
        }
        if (changes.machineProfileId)
          await assertUsableProfile(conn, actor, changes.machineProfileId);

        await repo.updateMetadata(id, {
          ...changes,
          ...('title' in changes ? { title: changes.title.trim() } : {}),
        });
        return toResponse(await repo.findById(id));
      });
    },

    /** Autosave with optimistic concurrency (If-Match: "<draftRevision>"). */
    async saveDraft(actor, id, ifMatch, document) {
      const expected = parseIfMatch(ifMatch);
      const repo = createProjectsRepository(db);
      const { project, collaborator } = await loadReadable(repo, actor, id);
      if (!canEditDraft(actor, project, collaborator)) throw errors.forbidden();
      assertEditableState(project);

      const issues = validateDocument(document);
      if (issues.length) throw errors.validation(issues, 'The design document is not valid.');

      if (!(await repo.saveDraft(id, expected, document))) {
        const current = await repo.findById(id);
        if (!current) throw errors.notFound();
        throw errors.draftConflict(current.draftRevision);
      }
      return { draftRevision: expected + 1 };
    },

    /**
     * Snapshots the draft as an immutable version. If the canonical draft hashes the same as the
     * latest version, that version is returned instead (created: false).
     */
    async createVersion(actor, id, { label } = {}) {
      return transaction(db, async (conn) => {
        const projects = createProjectsRepository(conn);
        const versions = createVersionsRepository(conn);
        // Lock the project row: serialises version numbering for this project.
        const { project, collaborator } = await loadReadable(projects, actor, id, {
          withDraft: true,
          forUpdate: true,
        });
        if (!canEditDraft(actor, project, collaborator)) throw errors.forbidden();
        assertEditableState(project);

        if (!project.draft) {
          throw errors.validation([{ path: '/draft', issue: 'project has no draft to snapshot' }]);
        }
        const issues = validateDocument(project.draft);
        if (issues.length) throw errors.validation(issues, 'The saved draft is not valid.');

        const { json, sha256, document } = canonicalize(project.draft);
        const latest = await versions.latest(id);
        if (latest && latest.documentSha256 === sha256) return { version: latest, created: false };

        const version = {
          id: newId(),
          projectId: id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          documentSchemaVersion: document.schemaVersion,
          documentSha256: sha256,
          label: label ?? null,
          reason: 'manual',
          createdBy: actor.userId,
          createdAt: new Date(),
        };
        await versions.insert({ ...version, documentJson: json });
        await projects.setCurrentVersion(id, version.id);
        return { version, created: true };
      });
    },

    async listVersions(actor, id, query) {
      const limit = parseLimit(query.limit);
      const after = decodeCursor(query.cursor, (k) => Number.isInteger(k?.n) && k.n > 0);
      await loadReadable(createProjectsRepository(db), actor, id);
      const rows = await createVersionsRepository(db).list(id, {
        beforeNumber: after?.n,
        limit: limit + 1,
      });
      return toPage(rows, limit, (v) => ({ n: v.versionNumber }));
    },
  };
}

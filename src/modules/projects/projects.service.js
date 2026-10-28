import { createHash } from 'node:crypto';
import { transaction } from '../../db/transaction.js';
import { errors } from '../../http/errors.js';
import { decodeCursor, parseEnum, parseLimit, toPage } from '../../http/pagination.js';
import {
  canonicalize,
  canonicalJson,
  emptyDocument,
  validateDocument,
} from '../../lib/document/validate-document.js';
import { newId } from '../../lib/ids.js';
import { createReferenceRepository } from '../reference/index.js';
import { loadReadableWith, UUID } from './projects.access.js';
import {
  canCreateExport,
  canCreateProject,
  canEditDraft,
  canManageCollaborators,
  canSubmit,
} from './projects.policy.js';
import { createProjectsRepository } from './projects.repository.js';
import { createVersionsRepository } from './versions.repository.js';

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

const TITLE_MAX = 200;

/** Optional on POSTs other than job creation (04-api/conventions.md). */
function parseOptionalIdempotencyKey(raw) {
  if (raw === undefined) return null;
  const key = raw.trim();
  if (!key || key.length > 128) {
    throw errors.badRequest('Idempotency-Key header must be 1–128 characters.');
  }
  return key;
}

/** Same key + same request → same copy. The fingerprint covers the source project and body. */
function fingerprint(projectId, input) {
  return createHash('sha256')
    .update(canonicalJson({ projectId, ...input }))
    .digest('hex');
}

const isDuplicateKey = (err) => err?.code === 'ER_DUP_ENTRY';

function parseIfMatch(header) {
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(header ?? '');
  if (!m) throw errors.badRequest('If-Match header with the current draftRevision is required.');
  return Number(m[1]);
}

export function createProjectsService({ db }) {
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
      const { project, collaborator } = await loadReadableWith(repo, actor, id, {
        withDraft: true,
      });
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
        const { project, collaborator } = await loadReadableWith(repo, actor, id, {
          forUpdate: true,
        });
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
      const { project, collaborator } = await loadReadableWith(repo, actor, id);
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
        const { project, collaborator } = await loadReadableWith(projects, actor, id, {
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

    /**
     * Copies a version (or, without versionId, the current draft) into a new private project
     * owned by the caller. The copy starts with version 1 (reason 'duplicate'). Rights
     * declarations are not copied (07-security-licensing/intellectual-property.md).
     * @returns {Promise<{ project: object, created: boolean }>}
     */
    async duplicate(actor, id, input = {}, rawKey) {
      if (!canCreateProject(actor)) throw errors.forbidden();
      const key = parseOptionalIdempotencyKey(rawKey);
      const repo = createProjectsRepository(db);
      const { project: source } = await loadReadableWith(repo, actor, id, { withDraft: true });

      const requestSha256 = key ? fingerprint(id, input) : null;
      async function replay() {
        const existing = await repo.findByDuplicateKey(actor.userId, key);
        if (!existing) return null;
        if (existing.requestSha256 !== requestSha256) throw errors.idempotencyKeyReused();
        return toResponse(existing);
      }
      if (key) {
        const replayed = await replay();
        if (replayed) return { project: replayed, created: false };
      }

      let sourceDocument = source.draft;
      if (input.versionId) {
        const version = await createVersionsRepository(db).findWithDocument(input.versionId);
        if (!version || version.projectId !== id) {
          throw errors.validation([
            { path: '/versionId', issue: 'is not a version of this project' },
          ]);
        }
        sourceDocument = version.document;
      }
      if (!sourceDocument) {
        throw errors.validation([{ path: '/draft', issue: 'project has no draft to copy' }]);
      }
      const issues = validateDocument(sourceDocument);
      if (issues.length) throw errors.validation(issues, 'The source document is not valid.');

      const title = input.title?.trim() || `Copy of ${source.title}`.slice(0, TITLE_MAX);
      if (title.length > TITLE_MAX) {
        throw errors.validation([
          { path: '/title', issue: `is longer than ${TITLE_MAX} characters` },
        ]);
      }
      // A "My Machine" profile of another user is not the caller's to use.
      const profile = source.machineProfileId
        ? await createReferenceRepository(db).findMachineProfile(
            source.machineProfileId,
            actor.userId,
          )
        : null;

      const { json, sha256, document } = canonicalize(sourceDocument);
      const copy = {
        id: newId(),
        ownerUserId: actor.userId,
        title,
        description: source.description,
        machineProfileId: profile?.id ?? null,
        draft: document,
        duplicatedFromProjectId: id,
        idempotencyKey: key,
        requestSha256,
      };
      try {
        await transaction(db, async (conn) => {
          const projects = createProjectsRepository(conn);
          await projects.insertDuplicate(copy);
          const versionId = newId();
          await createVersionsRepository(conn).insert({
            id: versionId,
            projectId: copy.id,
            versionNumber: 1,
            documentSchemaVersion: document.schemaVersion,
            documentJson: json,
            documentSha256: sha256,
            label: null,
            reason: 'duplicate',
            createdBy: actor.userId,
            createdAt: new Date(),
          });
          await projects.setCurrentVersion(copy.id, versionId);
        });
      } catch (err) {
        // A concurrent request with the same key won the insert.
        if (!key || !isDuplicateKey(err)) throw err;
        const winner = await replay();
        if (!winner) throw err;
        return { project: winner, created: false };
      }
      return { project: toResponse(await repo.findById(copy.id)), created: true };
    },

    async listVersions(actor, id, query) {
      const limit = parseLimit(query.limit);
      const after = decodeCursor(query.cursor, (k) => Number.isInteger(k?.n) && k.n > 0);
      await loadReadableWith(createProjectsRepository(db), actor, id);
      const rows = await createVersionsRepository(db).list(id, {
        beforeNumber: after?.n,
        limit: limit + 1,
      });
      return toPage(rows, limit, (v) => ({ n: v.versionNumber }));
    },
  };
}

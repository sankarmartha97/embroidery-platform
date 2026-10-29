import { createHmac } from 'node:crypto';
import { transaction } from '../../db/transaction.js';
import { errors } from '../../http/errors.js';
import { decodeCursor, parseEnum, parseLimit, toPage } from '../../http/pagination.js';
import { newId } from '../../lib/ids.js';
import { createArtifactsRepository } from '../artifacts/index.js';
import {
  canReview,
  canSubmit,
  createVersionsRepository,
  findProjectAccess,
  listProjectAssetIds,
  loadReadableProject,
  setProjectState,
} from '../projects/index.js';
import { createRightsRepository, missingRights } from '../rights/index.js';
import { createPublicationsRepository } from './publications.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = [
  'submitted',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
  'taken_down',
];
const OPEN = new Set(['submitted', 'in_review']);
const DECISIONS = { approve: 'approved', reject: 'rejected', request_changes: 'changes_requested' };
const PASSING = new Set(['passed', 'warning']);
// Placeholder until legal publishes the creator terms (12-business/legal-compliance-checklist.md).
export const CREATOR_TERMS_VERSION = 'creator-terms-draft-2026-10';

/**
 * Submission and moderation (FS-6.4, FS-11.1; S9-01). Approval publishes the exact submitted
 * version (FR-18); reject and request changes return the project to draft.
 */
export function createPublicationsService({ db, ipHashSecret }) {
  const hashIp = (ip) => (ip ? createHmac('sha256', ipHashSecret).update(ip).digest('hex') : null);

  /** FR-17 "a passing export exists": a machine file of the version, and stitch data that passed. */
  async function hasPassingExport(projectId, versionId) {
    const artifacts = createArtifactsRepository(db);
    const [machineFile] = await artifacts.listByProject(projectId, {
      versionId,
      type: 'machine_file',
      limit: 1,
    });
    const stitchData = await artifacts.latestStitchData(versionId);
    return Boolean(machineFile) && PASSING.has(stitchData?.validationStatus);
  }

  /** Publication with what a moderator reviews: project, version, validation and rights. */
  async function detail(publication, project) {
    const [version, stitchData, rights] = await Promise.all([
      createVersionsRepository(db).findById(publication.projectVersionId),
      createArtifactsRepository(db).latestStitchData(publication.projectVersionId),
      createRightsRepository(db).listByProject(publication.projectId),
    ]);
    return {
      ...publication,
      project: {
        id: project.id,
        title: project.title,
        description: project.description,
        ownerUserId: project.ownerUserId,
      },
      versionNumber: version.versionNumber,
      validationStatus: stitchData?.validationStatus ?? null,
      rights,
    };
  }

  return {
    async submit(actor, projectId, { versionId }, { ip } = {}) {
      const { project } = await loadReadableProject(db, actor, projectId);
      if (!canSubmit(actor, project)) throw errors.forbidden();
      const version = await createVersionsRepository(db).findById(versionId);
      if (!version || version.projectId !== projectId) {
        throw errors.validation([
          { path: '/versionId', issue: 'is not a version of this project' },
        ]);
      }
      if (project.status !== 'draft') {
        throw errors.invalidState(
          `A ${project.status.replace('_', ' ')} project cannot be submitted.`,
        );
      }

      const [rights, assetIds] = await Promise.all([
        createRightsRepository(db).listByProject(projectId),
        listProjectAssetIds(db, projectId),
      ]);
      const missing = missingRights(rights, assetIds);
      if (missing.length) throw errors.rightsDeclarationRequired(missing);
      if (!(await hasPassingExport(projectId, versionId))) throw errors.passingExportRequired();

      const publication = {
        id: newId(),
        projectId,
        projectVersionId: versionId,
        submittedBy: actor.userId,
      };
      await transaction(db, async (conn) => {
        // Lock the project row: one open submission per project.
        const { project: locked } = await loadReadableProject(conn, actor, projectId, {
          forUpdate: true,
        });
        const publications = createPublicationsRepository(conn);
        if (locked.status !== 'draft' || (await publications.findOpen(projectId))) {
          throw errors.invalidState('This project already has a submission in review.');
        }
        await publications.insert(publication);
        await createRightsRepository(conn).recordCreatorTerms({
          id: newId(),
          userId: actor.userId,
          projectId,
          termsVersion: CREATOR_TERMS_VERSION,
          clientIpHash: hashIp(ip),
        });
        await setProjectState(conn, projectId, { status: 'in_review' });
      });
      return createPublicationsRepository(db).findById(publication.id);
    },

    async listForProject(actor, projectId) {
      await loadReadableProject(db, actor, projectId);
      return { data: await createPublicationsRepository(db).listByProject(projectId) };
    },

    /** Moderators see any publication; others see those of projects they can read. */
    async get(actor, id) {
      const publication = UUID.test(id) && (await createPublicationsRepository(db).findById(id));
      if (!publication) throw errors.notFound();
      const { project } = await loadReadableProject(db, actor, publication.projectId);
      return detail(publication, project);
    },

    async queue(actor, query) {
      if (!canReview(actor)) throw errors.forbidden();
      const limit = parseLimit(query.limit);
      const status = parseEnum('status', query.status, STATUSES, 'submitted');
      const after = decodeCursor(
        query.cursor,
        (k) => typeof k?.s === 'string' && !Number.isNaN(Date.parse(k.s)) && UUID.test(k?.i),
      );
      const rows = await createPublicationsRepository(db).listByStatus({
        status,
        after: after && { submittedAt: new Date(after.s), id: after.i },
        limit: limit + 1,
      });
      const page = toPage(rows, limit, (p) => ({ s: p.submittedAt.toISOString(), i: p.id }));
      const data = await Promise.all(
        page.data.map(async (p) =>
          detail(p, (await findProjectAccess(db, actor, p.projectId)).project),
        ),
      );
      return { data, page: page.page };
    },

    /** staff.moderator only (SEC-T11). Every decision stores reviewer, time and reason (FR-18). */
    async review(actor, id, { decision, reason }) {
      if (!canReview(actor)) throw errors.forbidden();
      if (decision !== 'approve' && !reason?.trim()) {
        throw errors.validation([
          { path: '/reason', issue: 'is required to reject or request changes' },
        ]);
      }
      const status = DECISIONS[decision];
      const result = await transaction(db, async (conn) => {
        const publications = createPublicationsRepository(conn);
        const publication = UUID.test(id) && (await publications.findById(id, { forUpdate: true }));
        if (!publication) throw errors.notFound();
        if (!OPEN.has(publication.status)) {
          throw errors.invalidState(
            `This submission was already ${publication.status.replace('_', ' ')}.`,
          );
        }
        await publications.decide(id, {
          status,
          reviewerUserId: actor.userId,
          reason: reason?.trim(),
        });
        await setProjectState(
          conn,
          publication.projectId,
          status === 'approved'
            ? { status: 'published', visibility: 'marketplace' }
            : { status: 'draft' },
        );
        return publications.findById(id);
      });
      actor.audit?.('publication.decision', {
        publicationId: id,
        projectId: result.projectId,
        decision: status,
      });
      return result;
    },
  };
}

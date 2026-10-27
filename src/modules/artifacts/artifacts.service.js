import { createHmac } from 'node:crypto';
import { sha256 } from '../../lib/hash.js';
import { errors } from '../../http/errors.js';
import { parseEnum } from '../../http/pagination.js';
import {
  createVersionsRepository,
  downloadDecision,
  findProjectAccess,
  loadReadableProject,
} from '../projects/index.js';
import { createArtifactsRepository } from './artifacts.repository.js';
import { createExportEventsRepository } from './export-events.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ['source', 'stitch_data', 'preview', 'machine_file', 'report'];
// Stitch data is stored gzip-encoded (Content-Encoding: gzip), so .gz serves as JSON.
const CONTENT_TYPES = {
  json: 'application/json',
  gz: 'application/json',
  png: 'image/png',
  svg: 'image/svg+xml',
};

/** Never exposes storage keys. */
function toResponse(a) {
  return {
    id: a.id,
    projectVersionId: a.projectVersionId,
    jobId: a.jobId,
    artifactType: a.artifactType,
    formatCode: a.formatCode,
    sha256: a.sha256,
    fileSizeBytes: a.fileSizeBytes,
    stitchCount: a.stitchCount,
    colorCount: a.colorCount,
    widthMm: a.widthMm,
    heightMm: a.heightMm,
    engineName: a.engineName,
    engineVersion: a.engineVersion,
    validationStatus: a.validationStatus,
    createdAt: a.createdAt,
  };
}

/** "Heart outline" + v3 + key "…/id.dst" → heart-outline-v3.dst (ASCII only, no user paths). */
export function downloadFilename(title, versionNumber, storageKey) {
  const slug =
    String(title)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'design';
  const base = storageKey.slice(storageKey.lastIndexOf('/') + 1);
  const ext = base.slice(base.indexOf('.') + 1).replace(/\.gz$/, '');
  return `${slug}-v${versionNumber}.${ext}`;
}

export function createArtifactsService({ db, store, entitlements, ttlSeconds, ipHashSecret }) {
  const artifacts = createArtifactsRepository(db);
  const hashIp = (ip) => (ip ? createHmac('sha256', ipHashSecret).update(ip).digest('hex') : null);

  async function loadArtifact(artifactId) {
    if (!UUID.test(artifactId)) throw errors.notFound();
    const artifact = await artifacts.findById(artifactId);
    if (!artifact) throw errors.notFound();
    const version = await createVersionsRepository(db).findById(artifact.projectVersionId);
    return { artifact, version };
  }

  return {
    async list(actor, projectId, query) {
      await loadReadableProject(db, actor, projectId);
      const type = parseEnum('type', query.type, TYPES, undefined);
      if (query.versionId !== undefined && !UUID.test(query.versionId)) {
        throw errors.validation([{ path: '/versionId', issue: 'must be a version id' }]);
      }
      const rows = await artifacts.listByProject(projectId, { versionId: query.versionId, type });
      return { data: rows.map(toResponse) };
    },

    /**
     * Authorizes a download and issues a signed URL (≤ 5 min). Every decision is recorded in
     * design_export_events. Objects the caller cannot see are 404; a published design without
     * an entitlement is 403 ENTITLEMENT_REQUIRED.
     */
    async createDownloadUrl(actor, artifactId, { ip, userAgent }) {
      const { artifact, version } = await loadArtifact(artifactId);
      const event = {
        artifactId: artifact.id,
        userId: actor.userId,
        clientIpHash: hashIp(ip),
        userAgent,
        correlationId: actor.correlationId,
      };
      const events = createExportEventsRepository(db);

      const access = await findProjectAccess(db, actor, version.projectId);
      let decision = { allowed: false, basis: 'none', reason: 'NOT_VISIBLE' };
      let entitlement = null;
      if (access) {
        const { project, collaborator } = access;
        const publication =
          project.status === 'published'
            ? await artifacts.findApprovedPublication(project.id)
            : null;
        project.publishedVersionId = publication?.versionId ?? null;
        decision = downloadDecision(actor, project, collaborator, artifact, null);
        if (!decision.allowed && decision.reason === 'ENTITLEMENT_REQUIRED') {
          entitlement = await entitlements.getEntitlement(actor.userId, {
            projectId: project.id,
            listingRef: publication.listingRef,
          });
          decision = downloadDecision(actor, project, collaborator, artifact, entitlement);
        }
      }

      if (!decision.allowed) {
        await events.insert({
          ...event,
          decision: 'denied',
          basis: decision.basis,
          reasonCode: decision.reason,
        });
        if (decision.reason === 'ENTITLEMENT_REQUIRED') throw errors.entitlementRequired();
        if (decision.reason === 'EXPORT_NOT_ALLOWED') throw errors.forbidden();
        throw errors.notFound();
      }

      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const ext = artifact.storageKey.slice(artifact.storageKey.lastIndexOf('.') + 1);
      const url = await store.presignGet(artifact.storageKey, {
        expiresIn: ttlSeconds,
        filename: downloadFilename(
          access.project.title,
          version.versionNumber,
          artifact.storageKey,
        ),
        contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      });
      await events.insert({
        ...event,
        decision: 'allowed',
        basis: decision.basis,
        entitlementRef: entitlement?.ref,
        urlExpiresAt: expiresAt,
      });
      // The signed URL is a bearer credential: it is returned, never logged (SEC-T10).
      return { url, expiresAt, sha256: artifact.sha256 };
    },

    /** Stitch data for the Studio simulator (S5-06): gzip JSON, project readers only. */
    async stitchData(actor, artifactId) {
      const { artifact, version } = await loadArtifact(artifactId);
      if (artifact.artifactType !== 'stitch_data') throw errors.notFound();
      await loadReadableProject(db, actor, version.projectId);
      const body = await store.get(artifact.storageKey);
      if (sha256(body) !== artifact.sha256) {
        throw new Error(`stitch data checksum mismatch for artifact ${artifact.id}`);
      }
      return { body, sha256: artifact.sha256 };
    },
  };
}

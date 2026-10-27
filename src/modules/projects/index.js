// Projects API (routes/service/repository) arrives in sprint S3. The policy is the public surface now.
export {
  isStaff,
  canReadProject,
  canEditDraft,
  canCreateJob,
  canCreateExport,
  canDownloadArtifact,
  canSubmit,
  canReview,
  canManageRights,
} from './projects.policy.js';

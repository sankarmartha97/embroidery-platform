// Submission rules on the client (FS-6.3, FR-17). The server checks the same rules again; these
// only explain what is missing before the designer presses Submit.

export const RIGHTS_TYPES = [
  { id: 'owned', label: 'Original artwork by me' },
  {
    id: 'licensed',
    label: 'Licensed artwork',
    needsHolder: true,
    needsSource: true,
    sourceLabel: 'Licence id or URL',
  },
  {
    id: 'commissioned',
    label: 'Commissioned',
    needsHolder: true,
    needsSource: true,
    sourceLabel: 'Contract reference',
  },
  {
    id: 'public_domain',
    label: 'Public domain',
    needsSource: true,
    sourceLabel: 'Source and why it is public domain',
  },
];

const PASSING = new Set(['passed', 'warning']);

/**
 * @param {{ rights: object[], artifacts: object[] | null, terms: boolean }} state
 *   artifacts: the selected version's artifacts, or null while loading
 * @returns {{ items: Array<{ id: string, label: string, ok: boolean }>, ready: boolean }}
 */
export function submitChecklist({ rights, artifacts, terms }) {
  const hasRights = rights.some((r) => r.assetId === null && r.verificationStatus !== 'rejected');
  const stitchData = artifacts?.find((a) => a.artifactType === 'stitch_data');
  const exported = Boolean(artifacts?.some((a) => a.artifactType === 'machine_file'));
  const validated = PASSING.has(stitchData?.validationStatus);
  const items = [
    { id: 'rights', label: 'Rights declared for the design', ok: hasRights },
    { id: 'export', label: 'This version is exported to a machine file', ok: exported },
    {
      id: 'validated',
      label: 'Its stitch data passed validation (warnings allowed)',
      ok: validated,
    },
    { id: 'terms', label: 'Creator terms accepted', ok: terms },
  ];
  return { items, ready: items.every((i) => i.ok) };
}

export const PUBLICATION_LABEL = {
  submitted: 'Submitted',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Published',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  taken_down: 'Taken down',
};

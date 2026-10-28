'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, newIdempotencyKey } from '@/lib/api.js';
import { createAutosave, STATUS, STATUS_LABEL } from '@/lib/autosave.js';
import { hoopOf, nudge } from '@/lib/document.js';
import { addShape, setPath } from '@/lib/shapes.js';
import { createHistory, record, redo, reset, undo } from '@/lib/history.js';
import { pollJob } from '@/lib/jobs.js';
import { PUBLICATION_LABEL } from '@/lib/publishing.js';
import Canvas from './Canvas.js';
import ConflictModal from './ConflictModal.js';
import ExportDialog from './ExportDialog.js';
import HistoryDialog from './HistoryDialog.js';
import Inspector from './Inspector.js';
import JobChip from './JobChip.js';
import SequencePanel from './SequencePanel.js';
import ShareDialog from './ShareDialog.js';
import SubmitDialog from './SubmitDialog.js';

const TOOLS = [
  { id: 'select', label: 'Select (V)', key: 'v', glyph: '↖', ready: true },
  { id: 'rect', label: 'Rectangle (R)', key: 'r', glyph: '▭', ready: true },
  { id: 'ellipse', label: 'Ellipse (E)', key: 'e', glyph: '◯', ready: true },
  { id: 'polygon', label: 'Polygon (G)', key: 'g', glyph: '⬠', ready: true },
  { id: 'pen', label: 'Pen (P)', key: 'p', glyph: '✒', ready: true },
  { id: 'text', label: 'Text (coming soon)', glyph: 'T' },
  { id: 'import', label: 'Import SVG (coming soon)', glyph: '⇪' },
];

export default function Studio({ initialProject, formats, profiles }) {
  const projectId = initialProject.id;
  const [project, setProject] = useState(initialProject);
  const [history, setHistory] = useState(() => createHistory(initialProject.draft));
  const [selectedId, setSelectedIdRaw] = useState(null);
  const [tool, setToolRaw] = useState('select');
  const [editingId, setEditingId] = useState(null);
  const [save, setSave] = useState({
    status: STATUS.SAVED,
    revision: initialProject.draftRevision,
  });
  const [zoom, setZoom] = useState(100);
  const [jobs, setJobs] = useState({});
  const [issues, setIssues] = useState(null);
  const [inspectorTab, setInspectorTab] = useState('properties');
  const [notice, setNotice] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [dialog, setDialog] = useState(null); // 'history' | 'share' | 'submit' | null
  const [publication, setPublication] = useState(null);
  const [focus, setFocus] = useState(null);
  const autosave = useRef(null);
  const document = history.present;
  const canEdit = project.permissions?.canEdit !== false;
  const profile = profiles.find((p) => p.id === project.machineProfileId) ?? null;

  useEffect(() => {
    const instance = createAutosave({
      revision: initialProject.draftRevision,
      save: async (doc, revision) =>
        (
          await apiFetch(`/design-projects/${projectId}/draft`, {
            method: 'PUT',
            body: doc,
            headers: { 'If-Match': `"${revision}"` },
          })
        ).data,
      onChange: setSave,
    });
    autosave.current = instance;
    return () => instance.dispose();
  }, [projectId, initialProject.draftRevision]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (autosave.current?.hasUnsavedChanges()) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const apply = useCallback((next) => {
    setHistory((h) => record(h, next));
    autosave.current?.edit(next);
  }, []);
  const edit = (change) => canEdit && apply(change(document));

  // Selecting something else, or picking a tool, ends node editing.
  const setSelectedId = useCallback((id) => {
    setSelectedIdRaw(id);
    setEditingId((current) => (current && current !== id ? null : current));
  }, []);
  const setTool = useCallback((next) => {
    setToolRaw(next);
    setEditingId(null);
  }, []);

  function createShape(shape) {
    if (!canEdit) return;
    const { document: next, id } = addShape(document, shape);
    apply(next);
    setSelectedIdRaw(id);
    setToolRaw('select');
  }
  function startEditing(id) {
    setSelectedIdRaw(id);
    setEditingId(id);
    setToolRaw('select');
  }

  const doUndo = useCallback(() => {
    const next = undo(history);
    if (next === history) return;
    setHistory(next);
    autosave.current?.edit(next.present);
  }, [history]);
  const doRedo = useCallback(() => {
    const next = redo(history);
    if (next === history) return;
    setHistory(next);
    autosave.current?.edit(next.present);
  }, [history]);

  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.target.closest?.('input, textarea, select')) return;
      if (!mod && !e.altKey) {
        const picked = TOOLS.find((t) => t.ready && t.key === e.key.toLowerCase());
        if (picked && canEdit) setTool(picked.id);
        return;
      }
      if (!mod) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, setTool, canEdit]);

  // ---- Conflict resolution ----
  async function reloadTheirs() {
    const { data } = await apiFetch(`/design-projects/${projectId}`);
    setHistory(reset(data.draft));
    setProject(data);
    autosave.current.reset(data.draftRevision);
    setSelectedId(null);
  }
  async function saveMineAsVersion() {
    const { data } = await apiFetch(`/design-projects/${projectId}`);
    await autosave.current.overrideRevision(data.draftRevision);
    if (autosave.current.getState().status === STATUS.SAVED) {
      await apiFetch(`/design-projects/${projectId}/versions`, {
        method: 'POST',
        body: { label: 'Saved after an edit conflict' },
      });
      setNotice('Your version was saved. The other change is in the version history.');
    }
  }

  const closeDialog = useCallback(() => setDialog(null), []);

  // Latest submission, for the status chip (FS-6.4).
  useEffect(() => {
    apiFetch(`/design-projects/${projectId}/publications`)
      .then(({ data }) => setPublication(data.data[0] ?? null))
      .catch(() => {});
  }, [projectId]);

  function submitted(next) {
    setPublication(next);
    setProject((p) => ({ ...p, status: 'in_review' }));
    setDialog(null);
    setNotice('Submitted for review. You will see the moderator’s decision here.');
  }

  // ---- Version history ----
  /** Saves pending edits; throws if the draft cannot be saved (conflict, offline, invalid). */
  async function saveNow() {
    await autosave.current.flush();
    const state = autosave.current.getState();
    if (state.status !== STATUS.SAVED) {
      throw new Error(`Save the design first (${STATUS_LABEL[state.status]}).`);
    }
    return state.revision;
  }

  async function saveVersion(label) {
    await saveNow();
    await apiFetch(`/design-projects/${projectId}/versions`, {
      method: 'POST',
      body: label ? { label } : {},
    });
  }

  /** Restore makes a new head; the server keeps the current draft as a checkpoint version. */
  async function restoreVersion(version) {
    const revision = await saveNow();
    await apiFetch(`/design-projects/${projectId}/versions/${version.id}/restore`, {
      method: 'POST',
      headers: { 'If-Match': `"${revision}"` },
    });
    await reloadTheirs();
    setIssues(null);
    setNotice(
      `Restored version ${version.versionNumber}. Your previous draft is kept in the history.`,
    );
  }

  // ---- Jobs: snapshot the draft, queue the job, poll it ----
  /**
   * Runs a job against a fresh version of the saved draft and resolves with the final job.
   * Failures resolve as a failed job; an unsaved draft throws.
   */
  async function startJob(jobType, { machineProfileId, targetFormat, onUpdate } = {}) {
    setNotice(null);
    await autosave.current.flush();
    const status = autosave.current.getState().status;
    if (status !== STATUS.SAVED)
      throw new Error(`Save the design first (${STATUS_LABEL[status]}).`);
    const update = (job) => {
      setJobs((all) => ({ ...all, [jobType]: job }));
      onUpdate?.(job);
    };
    try {
      const { data: version } = await apiFetch(`/design-projects/${projectId}/versions`, {
        method: 'POST',
        body: {},
      });
      const body = { jobType, versionId: version.id };
      if (jobType !== 'digitize') body.digitizeIfMissing = true;
      if (machineProfileId) body.machineProfileId = machineProfileId;
      if (targetFormat) body.targetFormat = targetFormat;
      const { data: job } = await apiFetch(`/design-projects/${projectId}/jobs`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': newIdempotencyKey() },
      });
      update(job);
      return await pollJob(job.id, {
        getJob: async (id) => (await apiFetch(`/digitizing-jobs/${id}`)).data,
        onUpdate: update,
      });
    } catch (err) {
      const failed = {
        status: 'failed',
        jobType,
        error: { code: err.code ?? 'ERROR', summary: err.message },
        correlationId: err.correlationId,
      };
      update(failed);
      return failed;
    }
  }

  const readReport = async (job) =>
    (await apiFetch(`/artifacts/${job.outputArtifactIds[0]}/report`)).data;

  async function download(job) {
    const { data: link } = await apiFetch(`/artifacts/${job.outputArtifactIds[0]}/download-url`, {
      method: 'POST',
    });
    window.location.assign(link.url);
  }

  const cancelJob = (job) =>
    apiFetch(`/digitizing-jobs/${job.id}/cancel`, { method: 'POST' }).catch((err) =>
      setNotice(err.message),
    );

  function showIssues(report) {
    setIssues(report);
    setInspectorTab('issues');
  }

  async function runJob(jobType) {
    try {
      const done = await startJob(jobType);
      if (done.status === 'succeeded' && jobType === 'validate') showIssues(await readReport(done));
    } catch (err) {
      setNotice(err.message);
    }
  }

  /** Issues panel: select the object and glide the camera to it. */
  function focusObject(id) {
    setSelectedId(id);
    setFocus({ id, at: Date.now() });
  }

  async function changeProfile(machineProfileId) {
    const { data } = await apiFetch(`/design-projects/${projectId}`, {
      method: 'PATCH',
      body: { machineProfileId: machineProfileId || null },
    });
    setProject((p) => ({ ...p, ...data }));
  }

  async function rename(title) {
    if (!title.trim() || title === project.title) return;
    const { data } = await apiFetch(`/design-projects/${projectId}`, {
      method: 'PATCH',
      body: { title },
    });
    setProject((p) => ({ ...p, ...data }));
  }

  const busy = Object.values(jobs).some((j) => j && ['queued', 'running'].includes(j.status));
  const canValidate = Boolean(profile || document.machineProfile);

  return (
    <div className="studio">
      <div className="studio-too-small" role="note">
        The Studio needs a window at least 1280 × 800 pixels.
      </div>

      <header className="topbar">
        <Link href="/projects" className="btn btn-icon" aria-label="Back to projects">
          ←
        </Link>
        <input
          className="title-input"
          defaultValue={project.title}
          aria-label="Project title"
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          disabled={!canEdit}
        />
        <span className={`save-status save-${save.status}`} role="status" data-testid="save-status">
          {STATUS_LABEL[save.status]}
        </span>
        <div className="topbar-group">
          <button
            className="btn btn-icon"
            onClick={doUndo}
            disabled={history.past.length === 0}
            aria-label="Undo"
            title="Undo (Ctrl/⌘ Z)"
          >
            ↶
          </button>
          <button
            className="btn btn-icon"
            onClick={doRedo}
            disabled={history.future.length === 0}
            aria-label="Redo"
            title="Redo (Ctrl/⌘ Shift Z)"
          >
            ↷
          </button>
        </div>
        <span className="zoom num" aria-label="Zoom">
          {zoom}%
        </span>
        <div className="topbar-spacer" />
        <div className="topbar-group">
          {['digitize', 'validate', 'export'].map(
            (t) => jobs[t] && <JobChip key={t} job={jobs[t]} label={t} />,
          )}
        </div>
        <div className="topbar-group">
          <button className="btn" onClick={() => setDialog('history')}>
            History
          </button>
          {project.permissions?.canManageCollaborators && (
            <button className="btn" onClick={() => setDialog('share')}>
              Share
            </button>
          )}
          {publication && (
            <span
              className={`publication-chip publication-${publication.status}`}
              role="status"
              title={publication.decisionReason ?? undefined}
              data-testid="publication-status"
            >
              {PUBLICATION_LABEL[publication.status] ?? publication.status}
              {publication.decisionReason && ` · ${publication.decisionReason}`}
            </span>
          )}
          {project.permissions?.canSubmit && project.status === 'draft' && (
            <button className="btn" onClick={() => setDialog('submit')}>
              Submit
            </button>
          )}
        </div>
        <div className="topbar-group">
          <button className="btn" onClick={() => runJob('digitize')} disabled={busy || !canEdit}>
            Digitize
          </button>
          <button
            className="btn"
            onClick={() => runJob('validate')}
            disabled={busy || !canEdit || !canValidate}
            title={
              canValidate ? 'Check against the machine and hoop' : 'Pick a machine and hoop first'
            }
          >
            Validate{issues ? ` (${issues.issues.length})` : ''}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setExporting(true)}
            disabled={busy || !project.permissions?.canExport || formats.length === 0}
          >
            Export
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="btn btn-icon" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <nav className="tool-rail" aria-label="Tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool ${t.id === tool ? 'tool-active' : ''}`}
            disabled={!t.ready || (!canEdit && t.id !== 'select')}
            aria-label={t.label}
            title={t.label}
            aria-pressed={t.id === tool}
            onClick={() => setTool(t.id)}
          >
            {t.glyph}
          </button>
        ))}
      </nav>

      <SequencePanel
        document={document}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onEdit={edit}
        canEdit={canEdit}
      />

      <main className="canvas-area">
        <Canvas
          document={document}
          hoop={profile ? { w: profile.hoopWidthMm, h: profile.hoopHeightMm } : hoopOf(document)}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNudge={(id, dx, dy) => edit((d) => nudge(d, id, dx, dy))}
          onZoom={setZoom}
          tool={tool}
          onToolChange={setTool}
          onCreate={createShape}
          editingId={editingId}
          onStartEdit={startEditing}
          onEndEdit={() => setEditingId(null)}
          onEditPath={(id, d, closed) => edit((doc) => setPath(doc, id, d, closed))}
          focus={focus}
        />
      </main>

      <Inspector
        tab={inspectorTab}
        onTab={setInspectorTab}
        document={document}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onFocusObject={focusObject}
        onEdit={edit}
        canEdit={canEdit}
        issues={issues}
        profiles={profiles}
        profileId={project.machineProfileId}
        onProfile={changeProfile}
        editingId={editingId}
        onEditPoints={(id) => (editingId === id ? setEditingId(null) : startEditing(id))}
      />

      {exporting && (
        <ExportDialog
          document={document}
          formats={formats}
          profiles={profiles}
          profileId={project.machineProfileId}
          runJob={startJob}
          cancelJob={cancelJob}
          readReport={readReport}
          download={download}
          onShowIssues={(report) => {
            showIssues(report);
            setExporting(false);
          }}
          onClose={() => setExporting(false)}
        />
      )}

      {dialog === 'history' && (
        <HistoryDialog
          projectId={projectId}
          canEdit={canEdit}
          onSave={saveVersion}
          onRestore={restoreVersion}
          onClose={closeDialog}
        />
      )}
      {dialog === 'share' && <ShareDialog projectId={projectId} onClose={closeDialog} />}
      {dialog === 'submit' && (
        <SubmitDialog projectId={projectId} onSubmitted={submitted} onClose={closeDialog} />
      )}

      {save.status === STATUS.CONFLICT && (
        <ConflictModal onReload={reloadTheirs} onSaveMine={saveMineAsVersion} />
      )}
    </div>
  );
}

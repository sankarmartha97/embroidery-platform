'use client';

import { useState } from 'react';
import {
  setStitchType,
  STITCH_PARAMS,
  threadHex,
  updateObject,
  updateStitch,
} from '@/lib/document.js';

const SEVERITY_ORDER = { error: 0, warning: 1 };

export default function Inspector(props) {
  const { tab, onTab, issues } = props;
  const count = issues?.issues.length ?? 0;
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'properties'}
          className="tab"
          onClick={() => onTab('properties')}
        >
          Properties
        </button>
        <button
          role="tab"
          aria-selected={tab === 'issues'}
          className="tab"
          onClick={() => onTab('issues')}
        >
          Issues{issues ? ` (${count})` : ''}
        </button>
      </div>
      <div className="inspector-body" role="tabpanel">
        {tab === 'properties' ? <Properties {...props} /> : <Issues {...props} />}
      </div>
    </aside>
  );
}

function Properties({ document, selectedId, onEdit, canEdit, profiles, profileId, onProfile }) {
  const object = document.objects.find((o) => o.id === selectedId);
  if (!object) {
    return (
      <section className="stack">
        <h2 className="panel-title">Design</h2>
        <label className="field">
          <span>Machine and hoop</span>
          <select
            className="select"
            value={profileId ?? ''}
            onChange={(e) => onProfile(e.target.value)}
            disabled={!canEdit}
          >
            <option value="">None</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.hoopWidthMm} × {p.hoopHeightMm} mm)
              </option>
            ))}
          </select>
        </label>
        <dl className="facts">
          <dt>Canvas</dt>
          <dd className="num">
            {document.canvas.width} × {document.canvas.height} mm
          </dd>
          <dt>Objects</dt>
          <dd className="num">{document.objects.length}</dd>
          <dt>Threads</dt>
          <dd className="num">{document.threads.length}</dd>
        </dl>
        <p className="muted small">Select an object on the canvas or in the sequence to edit it.</p>
      </section>
    );
  }

  const params = object.stitch ? (STITCH_PARAMS[object.stitch.type] ?? []) : [];
  const [, , , , tx = 0, ty = 0] = object.transform ?? [1, 0, 0, 1, 0, 0];
  const setOffset = (axis, value) => {
    const [a, b, c, d, e, f] = object.transform ?? [1, 0, 0, 1, 0, 0];
    onEdit((doc) =>
      updateObject(doc, object.id, {
        transform: axis === 'x' ? [a, b, c, d, value, f] : [a, b, c, d, e, value],
      }),
    );
  };

  return (
    <section className="stack" key={object.id}>
      <h2 className="panel-title">
        {object.type === 'artwork-path' ? 'Artwork (not stitched)' : 'Object'}
      </h2>
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          defaultValue={object.name ?? ''}
          placeholder={object.id}
          maxLength={120}
          disabled={!canEdit}
          onBlur={(e) =>
            e.target.value !== (object.name ?? '') &&
            onEdit((d) => updateObject(d, object.id, { name: e.target.value }))
          }
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>

      <div className="row">
        <NumberField
          label="X offset"
          unit="mm"
          value={tx}
          step={0.1}
          disabled={!canEdit || object.locked}
          onCommit={(v) => setOffset('x', v)}
        />
        <NumberField
          label="Y offset"
          unit="mm"
          value={ty}
          step={0.1}
          disabled={!canEdit || object.locked}
          onCommit={(v) => setOffset('y', v)}
        />
      </div>

      {object.stitch && (
        <>
          <label className="field">
            <span>Stitch type</span>
            <select
              className="select"
              value={object.stitch.type}
              disabled={!canEdit}
              onChange={(e) => onEdit((d) => setStitchType(d, object.id, e.target.value))}
            >
              <option value="running">Running</option>
              <option value="satin">Satin</option>
              <option value="fill">Fill (tatami)</option>
            </select>
          </label>
          <label className="field">
            <span>Thread</span>
            <span className="thread-row">
              <span
                className="swatch"
                style={{ background: threadHex(document, object.stitch.threadId) }}
              />
              <select
                className="select"
                value={object.stitch.threadId}
                disabled={!canEdit}
                onChange={(e) =>
                  onEdit((d) => updateStitch(d, object.id, { threadId: e.target.value }))
                }
              >
                {document.threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} {t.hex}
                  </option>
                ))}
              </select>
            </span>
          </label>
          {params.map((p) => (
            <NumberField
              key={`${object.stitch.type}-${p.key}`}
              label={p.label}
              unit={p.unit}
              value={object.stitch[p.key] ?? p.default}
              min={p.min}
              max={p.max}
              step={p.step}
              disabled={!canEdit}
              onCommit={(v) => onEdit((d) => updateStitch(d, object.id, { [p.key]: v }))}
            />
          ))}
        </>
      )}

      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(object.hidden)}
            disabled={!canEdit}
            onChange={(e) =>
              onEdit((d) => updateObject(d, object.id, { hidden: e.target.checked }))
            }
          />
          Hidden
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(object.locked)}
            disabled={!canEdit}
            onChange={(e) =>
              onEdit((d) => updateObject(d, object.id, { locked: e.target.checked }))
            }
          />
          Locked
        </label>
      </div>
    </section>
  );
}

/** Number input with unit. Commits on blur or Enter, only when in range (schema ranges). */
function NumberField({ label, unit, value, min, max, step, disabled, onCommit }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? String(value);
  const parsed = Number(shown);
  const valid =
    shown.trim() !== '' &&
    Number.isFinite(parsed) &&
    (min === undefined || parsed >= min) &&
    (max === undefined || parsed <= max);
  function commit() {
    if (draft === null) return;
    if (valid && parsed !== value) onCommit(parsed);
    setDraft(null);
  }
  return (
    <label className="field">
      <span>
        {label}
        {min !== undefined && (
          <span className="muted">
            {' '}
            ({min}–{max} {unit})
          </span>
        )}
      </span>
      <span className={`number-field ${valid ? '' : 'is-invalid'}`}>
        <input
          className="input num"
          type="number"
          inputMode="decimal"
          value={shown}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={!valid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setDraft(null);
          }}
        />
        <span className="unit">{unit}</span>
      </span>
    </label>
  );
}

function Issues({ issues, document, onSelect, onTab }) {
  if (!issues)
    return (
      <p className="muted pad">Run Validate to check the design against the machine and hoop.</p>
    );
  if (issues.issues.length === 0) {
    return (
      <p className="issue-passed">
        <span aria-hidden="true">✓</span> No issues for{' '}
        {issues.machineProfile?.name ?? 'this machine'}.
      </p>
    );
  }
  const sorted = [...issues.issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const nameOf = (id) => document.objects.find((o) => o.id === id)?.name ?? id;
  return (
    <section className="stack">
      <p className="muted small">
        Checked against {issues.machineProfile?.name ?? 'the machine profile'}.
      </p>
      <ul className="issue-list">
        {sorted.map((issue) => (
          <li key={issue.code} className={`issue issue-${issue.severity}`}>
            <span className="issue-head">
              <span aria-hidden="true">{issue.severity === 'error' ? '✕' : '⚠'}</span>
              <strong>{issue.message ?? issue.code}</strong>
              {issue.count > 1 && <span className="num muted">×{issue.count}</span>}
            </span>
            <span className="mono small muted">{issue.code}</span>
            {issue.objectIds?.length > 0 && (
              <span className="issue-objects">
                {issue.objectIds.map((id) => (
                  <button
                    key={id}
                    className="chip"
                    onClick={() => {
                      onSelect(id);
                      onTab('properties');
                    }}
                  >
                    {nameOf(id)}
                  </button>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

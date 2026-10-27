'use client';

import { inSequence, moveInSequence, threadHex, updateObject } from '@/lib/document.js';

/**
 * Stitch order, selection, visibility and lock. Also the accessible model of the canvas: every
 * object can be selected and reordered here without a pointer (06-ui-ux accessibility).
 */
export default function SequencePanel({ document, selectedId, onSelect, onEdit, canEdit }) {
  const ordered = inSequence(document);
  return (
    <aside className="sequence-panel" aria-label="Sequence">
      <h2 className="panel-title">Sequence</h2>
      {ordered.length === 0 && (
        <p className="muted pad">No objects yet. Drawing tools are coming next.</p>
      )}
      <ol className="sequence-list">
        {ordered.map((o, i) => (
          <li key={o.id} className={o.id === selectedId ? 'is-selected' : undefined}>
            <button
              className="sequence-item"
              onClick={() => onSelect(o.id)}
              aria-current={o.id === selectedId ? 'true' : undefined}
            >
              <span
                className="swatch"
                style={{
                  background: o.stitch ? threadHex(document, o.stitch.threadId) : 'transparent',
                }}
              />
              <span className="sequence-name">{o.name ?? o.id}</span>
              <span className="muted small">{o.stitch?.type ?? 'artwork'}</span>
            </button>
            <span className="sequence-actions">
              <button
                className="mini"
                aria-label={`Move ${o.name ?? o.id} earlier`}
                disabled={!canEdit || i === 0}
                onClick={() => onEdit((d) => moveInSequence(d, o.id, -1))}
              >
                ↑
              </button>
              <button
                className="mini"
                aria-label={`Move ${o.name ?? o.id} later`}
                disabled={!canEdit || i === ordered.length - 1}
                onClick={() => onEdit((d) => moveInSequence(d, o.id, 1))}
              >
                ↓
              </button>
              <button
                className="mini"
                aria-label={o.hidden ? `Show ${o.name ?? o.id}` : `Hide ${o.name ?? o.id}`}
                aria-pressed={Boolean(o.hidden)}
                disabled={!canEdit}
                onClick={() => onEdit((d) => updateObject(d, o.id, { hidden: !o.hidden }))}
              >
                {o.hidden ? '◌' : '●'}
              </button>
              <button
                className="mini"
                aria-label={o.locked ? `Unlock ${o.name ?? o.id}` : `Lock ${o.name ?? o.id}`}
                aria-pressed={Boolean(o.locked)}
                disabled={!canEdit}
                onClick={() => onEdit((d) => updateObject(d, o.id, { locked: !o.locked }))}
              >
                {o.locked ? '🔒' : '🔓'}
              </button>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

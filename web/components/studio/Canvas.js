'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  actualSize,
  fit,
  frame,
  gridLevels,
  lerpCamera,
  pan,
  PX_PER_MM,
  rulerTicks,
  toWorld,
  zoomAt,
} from '@/lib/camera.js';
import { inSequence, objectBounds, threadHex } from '@/lib/document.js';
import {
  clampBox,
  clampPoint,
  dragBox,
  ellipsePath,
  MIN_SHAPE_MM,
  moveHandle,
  moveNode,
  parsePenPath,
  penPath,
  polygonPath,
  rectPath,
  round,
  smoothNode,
} from '@/lib/shapes.js';
import { DraftPreview, isNear, NodeEditor } from './drawing.js';

const RULER = 20;
const DRAG_THRESHOLD_PX = 3;
const FOCUS_MS = 320; // eased camera move to an issue (06-ui-ux/screen-specifications.md)

/** Node editing works on our own M/L/C/Z paths when the object is at most translated. */
export function editablePath(object) {
  const t = object?.transform ?? [1, 0, 0, 1, 0, 0];
  if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1) return null;
  const parsed = parsePenPath(object.geometry.d);
  return parsed && { ...parsed, offset: [t[4], t[5]] };
}

/**
 * Artwork view (06-ui-ux/studio-editor.md): SVG in mm with hoop, grid and rulers.
 * Ctrl/⌘ + wheel zooms to the cursor, wheel or Space-drag pans, 0 fits the hoop, 1 is actual size,
 * arrow keys nudge the selection. Drawing tools: drag for rectangles and ellipses (Shift: square,
 * circle); click points for polygons; click (corner) or click-drag (curve) for the pen. Click the
 * first point to close, Enter to finish, Backspace to remove the last point, Esc to cancel.
 */
export default function Canvas({
  document,
  hoop,
  selectedId,
  onSelect,
  onNudge,
  onZoom,
  tool = 'select',
  onCreate,
  onToolChange,
  editingId,
  onStartEdit,
  onEndEdit,
  onEditPath,
  focus,
}) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const [size, setSize] = useState(null);
  const [cam, setCam] = useState(null);
  const [draft, setDraft] = useState(null);
  const [nodeDrag, setNodeDrag] = useState(null);
  const panDrag = useRef(null);
  const spaceDown = useRef(false);
  const canvasMm = document.canvas;

  const fitHoop = useCallback(
    (s = size) => s && setCam(fit(s.w, s.h, { x: 0, y: 0, w: hoop.w, h: hoop.h })),
    [size, hoop.w, hoop.h],
  );

  // Latest hoop for the resize callback, which fits the hoop once the first size is known.
  const hoopRef = useRef(hoop);
  useEffect(() => {
    hoopRef.current = hoop;
  }, [hoop]);

  useEffect(() => {
    const el = wrapRef.current;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const s = { w: Math.max(1, width - RULER), h: Math.max(1, height - RULER) };
      setSize(s);
      setCam((c) => c ?? fit(s.w, s.h, { x: 0, y: 0, w: hoopRef.current.w, h: hoopRef.current.h }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (cam) onZoom?.(Math.round((cam.scale / PX_PER_MM) * 100));
  }, [cam, onZoom]);

  // Glide to an object when asked (`focus` is { id, at }; a new `at` repeats the move).
  const focusFrom = useRef({ cam, size, objects: document.objects });
  useEffect(() => {
    focusFrom.current = { cam, size, objects: document.objects };
  });
  useEffect(() => {
    const { cam: start, size: view, objects } = focusFrom.current;
    const object = focus && objects.find((o) => o.id === focus.id);
    const bounds = object && objectBounds(object);
    if (!bounds || !start || !view) return;
    const target = frame(view.w, view.h, bounds);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setCam(target);
      return;
    }
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / FOCUS_MS;
      setCam(lerpCamera(start, target, t, view.w, view.h));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  // Non-passive wheel listener so the page does not scroll while zooming.
  useEffect(() => {
    const el = wrapRef.current;
    function onWheel(e) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left - RULER;
      const sy = e.clientY - rect.top - RULER;
      setCam((c) =>
        !c
          ? c
          : e.ctrlKey || e.metaKey
            ? zoomAt(c, Math.exp(-e.deltaY * 0.0025), sx, sy)
            : pan(c, -e.deltaX, -e.deltaY),
      );
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Pointer position in mm, snapped to 0.1 mm and clamped to the canvas. */
  function worldAt(e) {
    const rect = svgRef.current.getBoundingClientRect();
    return clampPoint(toWorld(cam, [e.clientX - rect.left, e.clientY - rect.top]), canvasMm);
  }

  // ---- Finishing shapes ----
  function finishPolygon() {
    if (draft?.kind === 'poly' && draft.points.length >= 3) {
      onCreate({ kind: 'polygon', d: polygonPath(draft.points), closed: true });
    }
    setDraft(null);
  }
  function finishPen(closed) {
    if (draft?.kind === 'pen') {
      const enough = closed ? draft.nodes.length >= 3 : draft.nodes.length >= 2;
      if (enough) onCreate({ kind: 'pen', d: penPath(draft.nodes, closed), closed });
    }
    setDraft(null);
  }

  function onKeyDown(e) {
    if (e.key === ' ') {
      spaceDown.current = true;
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && draft) {
      if (draft.kind === 'poly') finishPolygon();
      if (draft.kind === 'pen') finishPen(false);
    } else if (e.key === 'Backspace' && draft && draft.kind !== 'box') {
      setDraft((d) =>
        d.kind === 'poly'
          ? { ...d, points: d.points.slice(0, -1) }
          : { ...d, nodes: d.nodes.slice(0, -1) },
      );
    } else if (e.key === 'Escape') {
      if (draft) setDraft(null);
      else if (editingId) onEndEdit();
      else if (tool !== 'select') onToolChange('select');
      else onSelect(null);
    } else if (e.key === '0') fitHoop();
    else if (e.key === '1' && size) setCam(actualSize(size.w, size.h, [hoop.w / 2, hoop.h / 2]));
    else if ((e.key === '+' || e.key === '=') && size)
      setCam((c) => zoomAt(c, 1.25, size.w / 2, size.h / 2));
    else if (e.key === '-' && size) setCam((c) => zoomAt(c, 0.8, size.w / 2, size.h / 2));
    else if (selectedId && e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 1 : 0.1;
      const [dx, dy] = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[e.key];
      onNudge(selectedId, dx, dy);
    } else return;
    e.preventDefault();
  }

  // ---- Pointer: pan (middle button or Space), drawing, node dragging ----
  function onPointerDown(e) {
    if (e.button === 1 || spaceDown.current) {
      panDrag.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || !cam || !e.target.closest?.('.canvas-svg')) return;
    const p = worldAt(e);

    if (tool === 'rect' || tool === 'ellipse') {
      setDraft({ kind: 'box', shape: tool, start: p, box: null });
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (tool === 'polygon') {
      const points = draft?.kind === 'poly' ? draft.points : [];
      if (points.length >= 3 && isNear(p, { x: points[0][0], y: points[0][1] }, cam))
        finishPolygon();
      else setDraft({ kind: 'poly', points: [...points, p], hover: p });
    } else if (tool === 'pen') {
      const nodes = draft?.kind === 'pen' ? draft.nodes : [];
      if (nodes.length >= 3 && isNear(p, nodes[0], cam)) {
        finishPen(true);
        return;
      }
      setDraft({
        kind: 'pen',
        nodes: [...nodes, { x: p[0], y: p[1] }],
        dragging: nodes.length,
        down: [e.clientX, e.clientY],
        hover: null,
      });
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e) {
    if (panDrag.current) {
      const dx = e.clientX - panDrag.current.x;
      const dy = e.clientY - panDrag.current.y;
      panDrag.current = { x: e.clientX, y: e.clientY };
      setCam((c) => pan(c, dx, dy));
      return;
    }
    if (!cam || !svgRef.current) return;
    if (nodeDrag) {
      const [x, y] = worldAt(e);
      const local = [round(x - nodeDrag.offset[0]), round(y - nodeDrag.offset[1])];
      const nodes =
        nodeDrag.which === 'node'
          ? moveNode(nodeDrag.start, nodeDrag.index, local)
          : moveHandle(nodeDrag.start, nodeDrag.index, nodeDrag.which, local);
      setNodeDrag((d) => ({ ...d, nodes }));
      return;
    }
    if (!draft) return;
    const p = worldAt(e);
    if (draft.kind === 'box') {
      setDraft((d) => ({
        ...d,
        box: clampBox(dragBox(d.start, p, { square: e.shiftKey }), canvasMm),
      }));
    } else if (draft.kind === 'poly') {
      setDraft((d) => ({ ...d, hover: p }));
    } else if (draft.kind === 'pen') {
      if (draft.dragging !== null && draft.dragging !== undefined) {
        const moved =
          Math.hypot(e.clientX - draft.down[0], e.clientY - draft.down[1]) > DRAG_THRESHOLD_PX;
        if (moved) {
          setDraft((d) => {
            const nodes = d.nodes.slice();
            const n = nodes[d.dragging];
            nodes[d.dragging] = smoothNode([n.x, n.y], p);
            return { ...d, nodes };
          });
        }
      } else setDraft((d) => ({ ...d, hover: p }));
    }
  }

  function onPointerUp() {
    panDrag.current = null;
    if (nodeDrag) {
      onEditPath(editingId, penPath(nodeDrag.nodes, nodeDrag.closed), nodeDrag.closed);
      setNodeDrag(null);
      return;
    }
    if (draft?.kind === 'box') {
      const { box } = draft;
      if (box && box.w >= MIN_SHAPE_MM && box.h >= MIN_SHAPE_MM) {
        onCreate({
          kind: draft.shape,
          d: draft.shape === 'ellipse' ? ellipsePath(box) : rectPath(box),
          closed: true,
        });
      }
      setDraft(null);
    } else if (draft?.kind === 'pen') {
      setDraft((d) => ({ ...d, dragging: null }));
    }
  }

  function grabNode(e, index, which) {
    e.stopPropagation();
    const editable = editablePath(document.objects.find((o) => o.id === editingId));
    if (!editable) return;
    wrapRef.current.setPointerCapture(e.pointerId);
    setNodeDrag({
      index,
      which,
      start: editable.nodes,
      nodes: editable.nodes,
      closed: editable.closed,
      offset: editable.offset,
    });
  }

  const selected = document.objects.find((o) => o.id === selectedId);
  const editing = editingId ? document.objects.find((o) => o.id === editingId) : null;
  const editable = editing ? editablePath(editing) : null;
  const bounds = selected && !editable ? objectBounds(selected) : null;
  const grid = cam ? gridLevels(cam.scale) : { minor: false, major: false };
  const selecting = tool === 'select';

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${tool}`}
      tabIndex={0}
      role="application"
      aria-label="Design canvas. Ctrl or Command plus wheel zooms, wheel or Space-drag pans, 0 fits the hoop, 1 shows actual size, arrow keys move the selected object. Drawing tools: drag for rectangles and ellipses, click points for polygons and the pen, Enter finishes, Escape cancels."
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.key === ' ' && (spaceDown.current = false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="canvas"
    >
      {cam && size && (
        <>
          <Ruler axis="x" cam={cam} length={size.w} />
          <Ruler axis="y" cam={cam} length={size.h} />
          <div className="ruler-corner" aria-hidden="true">
            mm
          </div>
          <svg
            ref={svgRef}
            className="canvas-svg"
            width={size.w}
            height={size.h}
            style={{ left: RULER, top: RULER }}
            onClick={(e) => selecting && e.target === e.currentTarget && onSelect(null)}
            data-testid="canvas-svg"
          >
            <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.scale})`}>
              <rect
                x={0}
                y={0}
                width={hoop.w}
                height={hoop.h}
                rx={4}
                className="hoop-frame"
                vectorEffect="non-scaling-stroke"
                onClick={() => selecting && onSelect(null)}
              />
              {grid.minor && (
                <GridLines w={hoop.w} h={hoop.h} step={1} className="grid-minor" skipEvery={10} />
              )}
              {grid.major && <GridLines w={hoop.w} h={hoop.h} step={10} className="grid-major" />}
              <rect
                x={0}
                y={0}
                width={hoop.w}
                height={hoop.h}
                className="hoop-field"
                vectorEffect="non-scaling-stroke"
              />

              <g pointerEvents={selecting ? undefined : 'none'}>
                {inSequence(document)
                  .filter((o) => !o.hidden)
                  .map((o) => {
                    const hex = o.stitch ? threadHex(document, o.stitch.threadId) : '#a8a29e';
                    const filled = o.stitch?.type === 'fill' || o.stitch?.type === 'satin';
                    const select = (e) => {
                      e.stopPropagation();
                      onSelect(o.id);
                    };
                    const edit = (e) => {
                      e.stopPropagation();
                      if (!o.locked && editablePath(o)) onStartEdit(o.id);
                    };
                    const transform = o.transform ? `matrix(${o.transform.join(' ')})` : undefined;
                    return (
                      <g key={o.id} opacity={editingId && editingId !== o.id ? 0.5 : 1}>
                        <path
                          d={o.geometry.d}
                          transform={transform}
                          fill={filled && o.geometry.closed ? hex : 'none'}
                          fillOpacity={o.stitch?.type === 'satin' ? 0.55 : 0.35}
                          stroke={hex}
                          strokeWidth={o.type === 'artwork-path' ? 1 : 2}
                          strokeDasharray={o.type === 'artwork-path' ? '4 3' : undefined}
                          vectorEffect="non-scaling-stroke"
                          className="design-object"
                          data-object-id={o.id}
                          onClick={select}
                          onDoubleClick={edit}
                        >
                          <title>{o.name ?? o.id}</title>
                        </path>
                        {/* Invisible 10 px hit area along the outline, so thin lines are easy to pick. */}
                        <path
                          d={o.geometry.d}
                          transform={transform}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={10}
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="stroke"
                          className="design-object-hit"
                          onClick={select}
                          onDoubleClick={edit}
                        />
                      </g>
                    );
                  })}
              </g>

              {bounds && (
                <g className="selection" pointerEvents="none">
                  <rect
                    x={bounds.x}
                    y={bounds.y}
                    width={bounds.w}
                    height={bounds.h}
                    vectorEffect="non-scaling-stroke"
                  />
                  {[
                    ['nw', bounds.x, bounds.y],
                    ['ne', bounds.x + bounds.w, bounds.y],
                    ['sw', bounds.x, bounds.y + bounds.h],
                    ['se', bounds.x + bounds.w, bounds.y + bounds.h],
                  ].map(([corner, x, y]) => (
                    <rect
                      key={corner}
                      className="handle"
                      x={x - 4 / cam.scale}
                      y={y - 4 / cam.scale}
                      width={8 / cam.scale}
                      height={8 / cam.scale}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              )}

              {editable && (
                <NodeEditor
                  nodes={nodeDrag?.nodes ?? editable.nodes}
                  closed={editable.closed}
                  offset={editable.offset}
                  cam={cam}
                  onGrab={grabNode}
                />
              )}
              <DraftPreview draft={draft} cam={cam} />
            </g>
          </svg>
        </>
      )}
      <p className="sr-only" aria-live="polite">
        {draft
          ? 'Drawing. Enter finishes, Escape cancels.'
          : editing
            ? `Editing points of ${editing.name ?? editing.id}. Escape finishes.`
            : selected
              ? `Selected ${selected.name ?? selected.id}`
              : 'Nothing selected'}
      </p>
    </div>
  );
}

function GridLines({ w, h, step, className, skipEvery }) {
  const lines = [];
  for (let x = step; x < w; x += step) {
    if (!skipEvery || Math.round(x) % skipEvery !== 0) lines.push(`M${x} 0V${h}`);
  }
  for (let y = step; y < h; y += step) {
    if (!skipEvery || Math.round(y) % skipEvery !== 0) lines.push(`M0 ${y}H${w}`);
  }
  return (
    <path
      d={lines.join('')}
      className={className}
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"
    />
  );
}

function Ruler({ axis, cam, length }) {
  const ticks = rulerTicks(cam, axis, length);
  const horizontal = axis === 'x';
  return (
    <svg
      className={`ruler ruler-${axis}`}
      width={horizontal ? length : RULER}
      height={horizontal ? RULER : length}
      style={horizontal ? { left: RULER, top: 0 } : { left: 0, top: RULER }}
      aria-hidden="true"
    >
      {ticks.map((t) =>
        horizontal ? (
          <g key={t.mm}>
            <line x1={t.px} x2={t.px} y1={t.major ? 6 : 14} y2={RULER} />
            {t.major && (
              <text x={t.px + 3} y={10}>
                {t.mm}
              </text>
            )}
          </g>
        ) : (
          <g key={t.mm}>
            <line y1={t.px} y2={t.px} x1={t.major ? 6 : 14} x2={RULER} />
            {t.major && (
              <text x={10} y={t.px + 3} transform={`rotate(-90 10 ${t.px + 3})`}>
                {t.mm}
              </text>
            )}
          </g>
        ),
      )}
    </svg>
  );
}

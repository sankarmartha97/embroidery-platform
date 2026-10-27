'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { actualSize, fit, gridLevels, pan, PX_PER_MM, rulerTicks, zoomAt } from '@/lib/camera.js';
import { inSequence, objectBounds, threadHex } from '@/lib/document.js';

const RULER = 20;

/**
 * Artwork view (06-ui-ux/studio-editor.md): SVG in mm with hoop, grid and rulers.
 * Wheel + Ctrl/⌘ zooms to the cursor, wheel or Space-drag pans, 0 fits the hoop, 1 is actual
 * size, arrow keys nudge the selection (Shift: 1 mm), Esc clears it.
 */
export default function Canvas({ document, hoop, selectedId, onSelect, onNudge, onZoom }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState(null);
  const [cam, setCam] = useState(null);
  const drag = useRef(null);
  const spaceDown = useRef(false);

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

  function onKeyDown(e) {
    if (e.key === ' ') {
      spaceDown.current = true;
      e.preventDefault();
      return;
    }
    if (e.key === '0') fitHoop();
    else if (e.key === '1' && size) setCam(actualSize(size.w, size.h, [hoop.w / 2, hoop.h / 2]));
    else if ((e.key === '+' || e.key === '=') && size)
      setCam((c) => zoomAt(c, 1.25, size.w / 2, size.h / 2));
    else if (e.key === '-' && size) setCam((c) => zoomAt(c, 0.8, size.w / 2, size.h / 2));
    else if (e.key === 'Escape') onSelect(null);
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

  function onPointerDown(e) {
    if (e.button === 1 || spaceDown.current) {
      drag.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }
  function onPointerMove(e) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setCam((c) => pan(c, dx, dy));
  }
  function onPointerUp() {
    drag.current = null;
  }

  const selected = document.objects.find((o) => o.id === selectedId);
  const bounds = selected ? objectBounds(selected) : null;
  const grid = cam ? gridLevels(cam.scale) : { minor: false, major: false };

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      tabIndex={0}
      role="application"
      aria-label="Design canvas. Ctrl or Command plus wheel zooms, wheel or Space-drag pans, 0 fits the hoop, 1 shows actual size, arrow keys move the selected object."
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
            className="canvas-svg"
            width={size.w}
            height={size.h}
            style={{ left: RULER, top: RULER }}
            onClick={(e) => e.target === e.currentTarget && onSelect(null)}
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
                onClick={() => onSelect(null)}
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

              {inSequence(document)
                .filter((o) => !o.hidden)
                .map((o) => {
                  const hex = o.stitch ? threadHex(document, o.stitch.threadId) : '#a8a29e';
                  const filled = o.stitch?.type === 'fill' || o.stitch?.type === 'satin';
                  const select = (e) => {
                    e.stopPropagation();
                    onSelect(o.id);
                  };
                  const transform = o.transform ? `matrix(${o.transform.join(' ')})` : undefined;
                  return (
                    <g key={o.id}>
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
                      />
                    </g>
                  );
                })}

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
            </g>
          </svg>
        </>
      )}
      <p className="sr-only" aria-live="polite">
        {selected ? `Selected ${selected.name ?? selected.id}` : 'Nothing selected'}
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

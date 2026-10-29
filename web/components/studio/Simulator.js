'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fit, toWorld } from '@/lib/camera.js';
import {
  advance,
  boundary,
  clock,
  objectNear,
  positionOf,
  progressAt,
  speedAt,
} from '@/lib/simulator.js';

const HIT_PX = 6;

/**
 * Stitch simulator (FS-8.2, FS-8.3, FS-8.4; S6-08, S7-02). Canvas 2D: stitches up to the current
 * step are drawn incrementally while playing; scrubbing back redraws from the start. Jumps are
 * dashed (toggle), trims marked. Clicking a sewn stitch selects its object.
 * Keys: Space play/pause, , and . step, [ and ] previous/next colour.
 */
export default function Simulator({
  playback,
  hoop,
  selectedId,
  onSelect,
  outOfDate,
  onRefresh,
  onClose,
}) {
  const wrapRef = useRef(null);
  const stitchRef = useRef(null);
  const overlayRef = useRef(null);
  const drawn = useRef({ upTo: -1, key: null });
  const [size, setSize] = useState(null);
  const [at, setAt] = useState(playback.count - 1);
  const atRef = useRef(at);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(200);
  const [showJumps, setShowJumps] = useState(true);
  const last = playback.count - 1;
  const cam = size && fit(size.w, size.h, { x: 0, y: 0, w: hoop.w, h: hoop.h }, 32);

  useEffect(() => {
    const el = wrapRef.current;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(1, Math.floor(width)), h: Math.max(1, Math.floor(height)) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- Drawing ----
  const draw = useCallback(
    (upTo) => {
      const canvas = stitchRef.current;
      if (!canvas || !cam) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const key = `${size.w}x${size.h}@${dpr}:${showJumps}`;
      let from = drawn.current.upTo + 1;
      if (drawn.current.key !== key || upTo < drawn.current.upTo) {
        canvas.width = size.w * dpr;
        canvas.height = size.h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.w, size.h);
        ctx.strokeStyle = 'rgb(255 255 255 / 0.25)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(cam.x, cam.y, hoop.w * cam.scale, hoop.h * cam.scale);
        from = 0;
      }
      const { x, y, kind, colour } = playback;
      const sx = (i) => cam.x + x[i] * cam.scale;
      const sy = (i) => cam.y + y[i] * cam.scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Batch runs of the same kind and colour into one path.
      let i = Math.max(1, from);
      while (i <= upTo) {
        const k = kind[i];
        if (k === 2) {
          ctx.setLineDash([]);
          ctx.fillStyle = '#f5f5f4';
          ctx.font = '11px system-ui';
          ctx.fillText('✂', sx(i) + 3, sy(i) - 3);
          i++;
          continue;
        }
        if (k === 3) {
          i++;
          continue;
        }
        const c = colour[i];
        ctx.beginPath();
        ctx.moveTo(sx(i - 1), sy(i - 1));
        let j = i;
        while (j <= upTo && kind[j] === k && colour[j] === c) {
          ctx.lineTo(sx(j), sy(j));
          j++;
        }
        if (k === 0) {
          ctx.setLineDash([]);
          ctx.strokeStyle = playback.threads[c] ?? '#a8a29e';
          ctx.lineWidth = Math.max(1, 0.35 * cam.scale);
          ctx.stroke();
        } else if (showJumps) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgb(255 255 255 / 0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        i = j;
      }
      drawn.current = { upTo, key };
    },
    [cam, size, hoop, playback, showJumps],
  );

  useEffect(() => {
    draw(at);
    const overlay = overlayRef.current;
    if (!overlay || !cam || at < 0) return;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = size.w * dpr;
    overlay.height = size.h * dpr;
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nx = cam.x + playback.x[at] * cam.scale;
    const ny = cam.y + playback.y[at] * cam.scale;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(nx, ny, 6, 0, Math.PI * 2);
    ctx.moveTo(nx - 10, ny);
    ctx.lineTo(nx + 10, ny);
    ctx.moveTo(nx, ny - 10);
    ctx.lineTo(nx, ny + 10);
    ctx.stroke();
  }, [at, draw, cam, size, playback]);

  // ---- Playback ----
  useEffect(() => {
    atRef.current = at;
  }, [at]);
  useEffect(() => {
    if (!playing) return;
    let raf;
    let prev = performance.now();
    let carry = 0;
    const tick = (now) => {
      const step = advance(carry, now - prev, speed);
      carry = step.carry;
      prev = now;
      if (step.steps > 0) {
        atRef.current = Math.min(last, atRef.current + step.steps);
        setAt(atRef.current);
      }
      if (atRef.current >= last) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, last]);

  const play = () => {
    if (at >= last) setAt(0);
    setPlaying((p) => !p);
  };
  const go = (index) => {
    setPlaying(false);
    setAt(Math.min(last, Math.max(0, index)));
  };

  function onKeyDown(e) {
    const actions = {
      ' ': play,
      ',': () => go(at - 1),
      '.': () => go(at + 1),
      '[': () => go(boundary(playback, at, -1, 'colour')),
      ']': () => go(boundary(playback, at, 1, 'colour')),
    };
    const action = actions[e.key];
    if (!action || e.target.closest?.('input')) return;
    e.preventDefault();
    action();
  }

  function onCanvasClick(e) {
    if (!cam) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const point = toWorld(cam, [e.clientX - rect.left, e.clientY - rect.top]);
    const id = objectNear(playback, point, HIT_PX / cam.scale, at);
    if (id) onSelect(id);
  }

  const { sewn, seconds } = progressAt(playback, at);
  const current = at >= 0 ? playback.colour[at] : 0;
  const objectIndex = at >= 0 ? playback.object[at] : -1;
  const scrubBackground = `linear-gradient(to right, ${playback.blocks
    .map((b) => {
      const hex = playback.threads[b.colour] ?? '#a8a29e';
      const from = (b.from / Math.max(1, last)) * 100;
      const to = ((b.to + 1) / Math.max(1, last)) * 100;
      return `${hex} ${from}%, ${hex} ${Math.min(100, to)}%`;
    })
    .join(', ')})`;

  return (
    <div className="simulator" onKeyDown={onKeyDown} data-testid="simulator">
      {outOfDate && (
        <div className="simulator-stale" role="status">
          The design changed after this simulation.
          <button className="btn" onClick={onRefresh}>
            Simulate again
          </button>
        </div>
      )}
      <div ref={wrapRef} className="simulator-stage" tabIndex={0} aria-label="Stitch simulator">
        <canvas
          ref={stitchRef}
          className="simulator-canvas"
          style={size ? { width: size.w, height: size.h } : undefined}
          role="img"
          aria-label={`Stitch ${sewn} of ${playback.stats.stitches}`}
        />
        <canvas
          ref={overlayRef}
          className="simulator-canvas simulator-overlay"
          style={size ? { width: size.w, height: size.h } : undefined}
          onClick={onCanvasClick}
          aria-hidden="true"
        />
      </div>

      <div className="dock" role="toolbar" aria-label="Simulator controls">
        <button
          className="dock-btn"
          onClick={() => go(boundary(playback, at, -1, 'colour'))}
          aria-label="Previous colour ([)"
        >
          ⏮
        </button>
        <button
          className="dock-btn"
          onClick={() => go(boundary(playback, at, -1, 'object'))}
          aria-label="Previous object"
        >
          ⇤
        </button>
        <button className="dock-btn" onClick={() => go(at - 1)} aria-label="Step back (,)">
          ‹
        </button>
        <button
          className="dock-btn dock-play"
          onClick={play}
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="dock-btn" onClick={() => go(at + 1)} aria-label="Step forward (.)">
          ›
        </button>
        <button
          className="dock-btn"
          onClick={() => go(boundary(playback, at, 1, 'object'))}
          aria-label="Next object"
        >
          ⇥
        </button>
        <button
          className="dock-btn"
          onClick={() => go(boundary(playback, at, 1, 'colour'))}
          aria-label="Next colour (])"
        >
          ⏭
        </button>

        <input
          type="range"
          className="scrubber"
          min={0}
          max={Math.max(0, last)}
          value={Math.max(0, at)}
          onChange={(e) => go(Number(e.target.value))}
          style={{ background: scrubBackground }}
          aria-label="Position"
        />

        <span className="dock-counter num" data-testid="sim-counter">
          Stitch {sewn.toLocaleString('en-GB')} of {playback.stats.stitches.toLocaleString('en-GB')}
        </span>
        <span className="dock-counter num">{clock(seconds)}</span>
        <span className="dock-colour" title="Current colour">
          <span
            className="swatch"
            style={{ background: playback.threads[current] }}
            aria-hidden="true"
          />
          Colour {current + 1} of {playback.threads.length || 1}
        </span>
        {objectIndex >= 0 && (
          <span className="dock-counter muted">{playback.objectIds[objectIndex]}</span>
        )}

        <label className="dock-speed">
          <span>Speed</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(positionOf(speed) * 1000)}
            onChange={(e) => setSpeed(speedAt(Number(e.target.value) / 1000))}
            aria-label="Stitches per second"
            aria-valuetext={`${speed} stitches per second`}
          />
          <span className="num">{speed}/s</span>
        </label>
        <label className="check dock-check">
          <input
            type="checkbox"
            checked={showJumps}
            onChange={(e) => setShowJumps(e.target.checked)}
          />
          Jumps
        </label>
        <span className="dock-legend small">
          {count(playback.stats.jumps, 'jump')} · {count(playback.stats.trims, 'trim')} ·{' '}
          {count(playback.stats.colorChanges, 'colour change')}
        </span>
        <button className="btn" onClick={onClose}>
          Back to editing
        </button>
      </div>
      {selectedId && (
        <p className="sr-only" aria-live="polite">
          Selected {selectedId}
        </p>
      )}
    </div>
  );
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

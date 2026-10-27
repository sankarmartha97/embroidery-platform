'use client';

// Canvas overlays for the drawing tools (S3-05/S3-06): the shape being drawn, and node editing.
import { ellipsePath, penPath, polygonPath, rectPath } from '@/lib/shapes.js';

const CLOSE_RADIUS_PX = 8;

/** Preview of the shape being drawn, in world (mm) coordinates. */
export function DraftPreview({ draft, cam }) {
  if (!draft) return null;
  const r = 4 / cam.scale;
  if (draft.kind === 'box') {
    if (!draft.box || draft.box.w === 0 || draft.box.h === 0) return null;
    const d = draft.shape === 'ellipse' ? ellipsePath(draft.box) : rectPath(draft.box);
    return <path d={d} className="draft-path" vectorEffect="non-scaling-stroke" />;
  }
  const points = draft.kind === 'poly' ? draft.points.map(([x, y]) => ({ x, y })) : draft.nodes;
  if (points.length === 0) return null;
  const d =
    draft.kind === 'poly'
      ? polygonPath(draft.points).replace(/ Z$/, '')
      : penPath(draft.nodes, false);
  const last = points.at(-1);
  const nearStart = draft.hover && isNear(draft.hover, points[0], cam) && points.length > 2;
  return (
    <g pointerEvents="none">
      <path d={d} className="draft-path" vectorEffect="non-scaling-stroke" />
      {draft.hover && (
        <line
          x1={last.x}
          y1={last.y}
          x2={draft.hover[0]}
          y2={draft.hover[1]}
          className="draft-rubber"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {points.map((p, i) => (
        <rect
          key={i}
          x={p.x - r}
          y={p.y - r}
          width={2 * r}
          height={2 * r}
          className={i === 0 && nearStart ? 'node node-close' : 'node'}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {draft.kind === 'pen' &&
        draft.nodes.map(
          (n, i) =>
            n.out && (
              <g key={`h${i}`}>
                <line
                  x1={n.in[0]}
                  y1={n.in[1]}
                  x2={n.out[0]}
                  y2={n.out[1]}
                  className="handle-line"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={n.out[0]}
                  cy={n.out[1]}
                  r={r * 0.8}
                  className="handle-dot"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={n.in[0]}
                  cy={n.in[1]}
                  r={r * 0.8}
                  className="handle-dot"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ),
        )}
    </g>
  );
}

/**
 * Node editor: anchors (squares) and Bézier handles (circles) of the path being edited.
 * `offset` is the object's translation, so nodes are drawn where the object is.
 */
export function NodeEditor({ nodes, closed, offset, cam, onGrab }) {
  const r = 4.5 / cam.scale;
  const [ox, oy] = offset;
  return (
    <g className="node-editor" transform={`translate(${ox} ${oy})`}>
      <path
        d={penPath(nodes, closed)}
        className="edit-path"
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {nodes.map((n, i) => (
        <g key={i}>
          {['in', 'out'].map(
            (which) =>
              n[which] && (
                <g key={which}>
                  <line
                    x1={n.x}
                    y1={n.y}
                    x2={n[which][0]}
                    y2={n[which][1]}
                    className="handle-line"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                  <circle
                    cx={n[which][0]}
                    cy={n[which][1]}
                    r={r * 0.85}
                    className="handle-dot grab"
                    vectorEffect="non-scaling-stroke"
                    data-handle={`${i}-${which}`}
                    onPointerDown={(e) => onGrab(e, i, which)}
                  />
                </g>
              ),
          )}
          <rect
            x={n.x - r}
            y={n.y - r}
            width={2 * r}
            height={2 * r}
            className="node grab"
            vectorEffect="non-scaling-stroke"
            data-node={i}
            onPointerDown={(e) => onGrab(e, i, 'node')}
          />
        </g>
      ))}
    </g>
  );
}

export function isNear([x, y], p, cam) {
  return Math.hypot((x - p.x) * cam.scale, (y - p.y) * cam.scale) <= CLOSE_RADIUS_PX;
}

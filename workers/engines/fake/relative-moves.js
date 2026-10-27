/**
 * Converts absolute stitch-data commands (0.1 mm, centred) into relative moves, splitting any
 * move longer than `maxStep` per axis into extra jumps. Starts at the design origin (0, 0).
 * Yields { type: 'stitch'|'jump'|'color_change'|'end', dx, dy }.
 */
export function* relativeMoves(commands, maxStep) {
  let x = 0;
  let y = 0;
  let started = false;

  function* moveTo(tx, ty, finalType) {
    let dx = tx - x;
    let dy = ty - y;
    while (Math.abs(dx) > maxStep || Math.abs(dy) > maxStep) {
      const sx = Math.max(-maxStep, Math.min(maxStep, dx));
      const sy = Math.max(-maxStep, Math.min(maxStep, dy));
      yield { type: 'jump', dx: sx, dy: sy };
      x += sx;
      y += sy;
      dx -= sx;
      dy -= sy;
    }
    yield { type: finalType, dx, dy };
    x = tx;
    y = ty;
  }

  for (const [type, cx, cy] of commands) {
    if (type === 'stitch') {
      if (!started && (cx !== x || cy !== y)) yield* moveTo(cx, cy, 'jump');
      started = true;
      yield* moveTo(cx, cy, 'stitch');
    } else if (type === 'jump') {
      yield* moveTo(cx, cy, 'jump');
    } else if (type === 'color_change') {
      yield { type: 'color_change', dx: 0, dy: 0 };
    } else if (type === 'end') {
      yield { type: 'end', dx: 0, dy: 0 };
      return;
    }
    // 'trim' has no portable encoding here; real writers handle it per format.
  }
  yield { type: 'end', dx: 0, dy: 0 };
}

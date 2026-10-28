# Studio web app

Next.js app for the Studio ([06-ui-ux/studio-editor.md](../../embroidery-platform-docs/06-ui-ux/studio-editor.md)). Desktop only (at least 1280 × 800), built on the [design system](../../embroidery-platform-docs/06-ui-ux/design-system.md) tokens.

## Run it

Start the API and worker first (see the [root README](../README.md)), with your dev user as a designer:

```bash
# in the repository root
DEV_ROLE_ASSIGNMENTS='{"0190f0a0-0000-7000-8000-00000000de11":["designer"]}' npm run dev
npm run dev:worker
npm run -s dev:token            # copy the token

# here
npm ci
npm run dev                     # http://localhost:5001, API at http://127.0.0.1:3000 (API_ORIGIN)
```

Open http://localhost:5001 and paste the token on the sign-in page.

## How it is put together

| Part         | Where                                           | Notes                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session      | `lib/server/session.js`, `app/sign-in`          | The token lives in an **httpOnly** cookie; page scripts never see it. Dev sign-in (paste a token) exists only outside production, until marketplace sign-in is connected (A5)                                                                                                                                                                     |
| API proxy    | `app/api/v1/[...path]/route.js`                 | Same-origin proxy that adds the bearer token. Only listed headers pass                                                                                                                                                                                                                                                                            |
| Projects     | `app/projects`                                  | List and create (server-rendered with the session)                                                                                                                                                                                                                                                                                                |
| Studio       | `components/studio`                             | Top bar, tool rail, sequence panel, canvas, inspector, conflict dialog                                                                                                                                                                                                                                                                            |
| Canvas       | `components/studio/Canvas.js`, `lib/camera.js`  | SVG in mm: hoop, 1/10 mm grid, rulers, zoom to cursor (Ctrl/⌘ + wheel), pan (wheel, Space-drag), `0` fit hoop, `1` actual size (96 dpi), arrow-key nudge                                                                                                                                                                                          |
| Drawing      | `lib/shapes.js`, `components/studio/drawing.js` | Rectangle (R) and ellipse (E) by dragging, Shift for square/circle; polygon (G) by clicks; pen (P): click for corners, click-drag for curves. Click the first point to close, Enter to finish open, Backspace removes a point, Esc cancels. Closed shapes get a fill stitch, open paths a running stitch. Points snap to 0.1 mm inside the canvas |
| Node editing | `Canvas.js` (`NodeEditor`)                      | Double-click a drawn shape, or "Edit points" in the inspector: drag squares to move points, circles to bend curves. Works on M/L/C/Z paths (rectangles, polygons, pen paths); ellipses keep their arcs                                                                                                                                            |
| Editing      | `lib/document.js`, `lib/history.js`             | Pure edit commands; undo/redo ≥ 200 steps. Geometry uses the same SVG path parser as the API validator (`../src/lib`)                                                                                                                                                                                                                             |
| Autosave     | `lib/autosave.js`                               | 2 s debounce, 30 s max wait, `If-Match`; Saved · Saving… · Offline (retrying) · Conflict                                                                                                                                                                                                                                                          |
| Jobs         | `lib/jobs.js`, `JobChip.js`                     | Snapshot → job with `Idempotency-Key` → poll 1 s/2 s/5 s; validate shows issues by object; clicking an object in an issue glides the camera to it                                                                                                                                                                                                 |
| Export       | `ExportDialog.js`, `lib/exporting.js`           | Machine, format (native pre-selected, enabled formats only), hoop fit; a validate job runs first: errors block, warnings need "Export anyway"; staged progress with Cancel, then the download                                                                                                                                                     |

## Scripts

| Script                        | What it does                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev`                 | Dev server on port 5001                                                            |
| `npm run build` / `npm start` | Production build and server (dev sign-in is off)                                   |
| `npm test`                    | Unit tests for the pure modules (`node:test`)                                      |
| `npm run e2e`                 | Playwright against a running stack; needs `E2E_TOKEN` (a dev token for a designer) |
| `npm run lint`                | ESLint and Prettier                                                                |

## Not built yet

Text, SVG import, adding or removing nodes on an existing path, transform handles with drag, the simulator (S6-08), the "out of date" marker after edits, and marketplace sign-in (A5).

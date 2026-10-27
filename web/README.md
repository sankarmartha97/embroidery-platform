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
npm run dev                     # http://localhost:3001, API at http://127.0.0.1:3000 (API_ORIGIN)
```

Open http://localhost:3001 and paste the token on the sign-in page.

## How it is put together

| Part | Where | Notes |
| --- | --- | --- |
| Session | `lib/server/session.js`, `app/sign-in` | The token lives in an **httpOnly** cookie; page scripts never see it. Dev sign-in (paste a token) exists only outside production, until marketplace sign-in is connected (A5) |
| API proxy | `app/api/v1/[...path]/route.js` | Same-origin proxy that adds the bearer token. Only listed headers pass |
| Projects | `app/projects` | List and create (server-rendered with the session) |
| Studio | `components/studio` | Top bar, tool rail, sequence panel, canvas, inspector, conflict dialog |
| Canvas | `components/studio/Canvas.js`, `lib/camera.js` | SVG in mm: hoop, 1/10 mm grid, rulers, zoom to cursor (Ctrl/⌘ + wheel), pan (wheel, Space-drag), `0` fit hoop, `1` actual size (96 dpi), arrow-key nudge |
| Editing | `lib/document.js`, `lib/history.js` | Pure edit commands; undo/redo ≥ 200 steps. Geometry uses the same SVG path parser as the API validator (`../src/lib`) |
| Autosave | `lib/autosave.js` | 2 s debounce, 30 s max wait, `If-Match`; Saved · Saving… · Offline (retrying) · Conflict |
| Jobs | `lib/jobs.js`, `JobChip.js` | Snapshot → job with `Idempotency-Key` → poll 1 s/2 s/5 s; validate shows issues by object, export downloads the file |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3001 |
| `npm run build` / `npm start` | Production build and server (dev sign-in is off) |
| `npm test` | Unit tests for the pure modules (`node:test`) |
| `npm run e2e` | Playwright against a running stack; needs `E2E_TOKEN` (a dev token for a designer) |
| `npm run lint` | ESLint and Prettier |

## Not built yet

Drawing tools (pen, shapes, text), SVG import, transform handles with drag, the simulator (S6-08), the "out of date" marker after edits, and marketplace sign-in (A5).

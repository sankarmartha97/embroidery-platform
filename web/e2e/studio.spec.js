// S3-09 / S6-11 (first cut): sign in → create a project → edit with autosave and undo →
// resolve an edit conflict → validate → export, against the live stack.
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const SHOTS = process.env.E2E_SCREENSHOTS; // optional folder for review screenshots

test.describe.configure({ mode: 'serial' });

test.describe('Studio', () => {
  test.skip(!TOKEN, 'E2E_TOKEN is not set');
  let page;
  let projectId;

  const api = async (method, path, { data, headers } = {}) => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers });
    return { status: res.status(), body: res.status() === 204 ? null : await res.json() };
  };

  const consoleErrors = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));
  });
  test.afterAll(async () => page.close());

  test('sends a signed-out visitor to sign in, and signs in with a dev token', async () => {
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fprojects|\/sign-in\?next=\/projects/);
    await page.getByLabel('Developer token').fill('not-a-token');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('The API rejected this token')).toBeVisible();

    await page.getByLabel('Developer token').fill(TOKEN);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'emb_session');
    expect(session.httpOnly).toBe(true);
  });

  test('creates a project and opens the Studio on its hoop', async () => {
    await page.getByLabel('Title').fill(`E2E heart ${Date.now()}`);
    await page
      .getByLabel('Machine and hoop')
      .selectOption({ label: 'Tajima-compatible 100 x 100 (100 × 100 mm)' });
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page).toHaveURL(/\/studio\//);
    projectId = page.url().split('/studio/')[1];
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
    await expect(page.locator('.hoop-frame')).toBeVisible();

    // No drawing tools yet: seed a design through the API, then reload.
    const seeded = await api('PUT', `/design-projects/${projectId}/draft`, {
      data: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    expect(seeded.status).toBe(200);
    await page.reload();
    await expect(page.locator('[data-object-id="outline"]')).toBeVisible();
  });

  test('zooms with keys: 1 is actual size (100%), 0 fits the hoop', async () => {
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('1');
    await expect(page.getByLabel('Zoom', { exact: true })).toHaveText('100%');
    await page.keyboard.press('0');
    await expect(page.getByLabel('Zoom', { exact: true })).not.toHaveText('100%');
  });

  test('edits a property, autosaves it, and undoes it', async () => {
    // Canvas selection, then the sequence panel (the accessible route to every object).
    await page.locator('[data-object-id="outline"]').click();
    await expect(page.getByLabel('Name')).toHaveValue('Heart outline');
    await page.getByRole('button', { name: 'underline running' }).click();
    await expect(page.getByLabel('Name')).toHaveAttribute('placeholder', 'underline');
    const length = page.getByLabel(/Stitch length/);
    await length.fill('3.5');
    await length.press('Enter');
    await expect(page.getByTestId('save-status')).toHaveText('Unsaved changes');
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    let saved = await api('GET', `/design-projects/${projectId}`);
    expect(saved.body.draft.objects[1].stitch.stitchLengthMm).toBe(3.5);
    expect(saved.body.draftRevision).toBe(2);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(length).toHaveValue('2.5');
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
    saved = await api('GET', `/design-projects/${projectId}`);
    expect(saved.body.draft.objects[1].stitch.stitchLengthMm).toBe(2.5);
  });

  test('reorders the sequence and nudges with the arrow keys', async () => {
    await page.getByRole('button', { name: 'Move underline earlier' }).click();
    await expect(page.locator('.sequence-name').first()).toHaveText('underline');
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.getByLabel('X offset')).toHaveValue('1');
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });
  });

  test('shows the conflict dialog when another tab saved first, and reloads theirs', async () => {
    const current = await api('GET', `/design-projects/${projectId}`);
    const theirs = heartDocument({ canvas: { width: 100, height: 100 } });
    theirs.objects[0].name = 'Saved elsewhere';
    const other = await api('PUT', `/design-projects/${projectId}/draft`, {
      data: theirs,
      headers: { 'If-Match': `"${current.body.draftRevision}"` },
    });
    expect(other.status).toBe(200);

    await page.getByRole('button', { name: 'Hide underline' }).click();
    const dialog = page.getByRole('dialog', { name: /changed in another tab/ });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('save-status')).toHaveText('Conflict');
    await dialog.getByRole('button', { name: 'Reload their copy' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.sequence-name').first()).toHaveText('Saved elsewhere');
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
  });

  test('validates against the machine and lists issues by object', async () => {
    await page.getByRole('button', { name: /^Validate/ }).click();
    await expect(page.getByTestId('job-validate')).toContainText('Done', { timeout: 30_000 });
    await expect(page.getByRole('tab', { name: /Issues/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const issue = page.locator('.issue').filter({ hasText: 'MISSING_TRIM' });
    await expect(issue).toBeVisible();
    await issue.getByRole('button', { name: 'underline' }).click();
    await expect(page.getByRole('tab', { name: 'Properties' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByLabel('Name')).toHaveAttribute('placeholder', 'underline');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/studio.png` });
  });

  test('exports a DST file and downloads it', async () => {
    await page.getByLabel('Export format').selectOption('DST');
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Export' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^e2e-heart-\d+-v\d+\.dst$/);
    await expect(page.getByTestId('job-export')).toContainText('Done');
  });

  test('logged no errors in the browser console', () => {
    // The browser logs the planned 401 (invalid sign-in token) and 409 (edit conflict) responses.
    const planned = /^Failed to load resource: the server responded with a status of (401|409)\b/;
    expect(consoleErrors.filter((e) => !planned.test(e))).toEqual([]);
  });
});

// S8-01 / S8-04: projects list (tabs, duplicate), version history (save, restore, duplicate a
// version) and sharing, against the live stack. E2E_FRIEND is a second user in the users table
// (CI inserts it next to the dev user).
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const FRIEND = process.env.E2E_FRIEND ?? '0190f0a0-0000-7000-8000-00000000de12';
const SHOTS = process.env.E2E_SCREENSHOTS;
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';

test.describe.configure({ mode: 'serial' });

test.describe('Projects, history and sharing', () => {
  test.skip(!TOKEN, 'E2E_TOKEN is not set');
  let page;
  let project;
  const title = `History ${Date.now()}`;
  const consoleErrors = [];

  const api = async (method, path, data, headers) => {
    const res = await page.request.fetch(`/api/v1${path}`, { method, data, headers });
    return res.status() === 204 ? null : res.json();
  };

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'emb_session', value: TOKEN, url: baseURL, httpOnly: true }]);
    page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await page.goto('/projects');
    project = await api('POST', '/design-projects', { title, machineProfileId: TAJIMA_100 });
    await api('PUT', `/design-projects/${project.id}/draft`, heartDocument(), {
      'If-Match': '"0"',
    });
  });
  test.afterAll(async () => page.context().close());

  test('saves a named version, restores an older one, and keeps the draft as a checkpoint', async () => {
    await page.goto(`/studio/${project.id}`);
    await page.getByRole('button', { name: 'History' }).click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    await expect(dialog.getByText('No versions yet')).toBeVisible();
    await dialog.getByLabel('Version name').fill('First heart');
    await dialog.getByRole('button', { name: 'Save version' }).click();
    await expect(dialog.getByTestId('version-row')).toHaveCount(1);
    await expect(dialog.getByTestId('version-row').first()).toContainText('First heart');
    await dialog.getByRole('button', { name: 'Close' }).click();

    // Change the design, then restore v1.
    await page.locator('.sequence-name').first().click();
    await page.getByLabel('Name').fill('Changed');
    await page.getByLabel('Name').blur();
    await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 });

    await page.getByRole('button', { name: 'History' }).click();
    await dialog.getByRole('button', { name: 'Restore version 1' }).click();
    await expect(dialog.getByTestId('version-row')).toHaveCount(2);
    await expect(dialog.getByTestId('version-row').first()).toContainText(
      'Before restoring version 1',
    );
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/history.png` });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Restored version 1' })).toBeVisible();
    await expect(page.locator('.sequence-name').first()).toHaveText('Heart outline');
    await expect(page.getByTestId('save-status')).toHaveText('Saved');
  });

  test('duplicates a version into a new project', async () => {
    await page.getByRole('button', { name: 'History' }).click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    await dialog.getByRole('button', { name: 'Duplicate version 1' }).click();
    await expect(page).not.toHaveURL(new RegExp(project.id));
    await expect(page).toHaveURL(/\/studio\//);
    await expect(page.getByLabel('Project title')).toHaveValue(`Copy of ${title}`);
    await expect(page.locator('.sequence-name').first()).toHaveText('Heart outline');
  });

  test('shares the project, changes the role, and removes access', async () => {
    await page.goto(`/studio/${project.id}`);
    await page.getByRole('button', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share this project' });
    await expect(dialog.getByText('Only you can see this project.')).toBeVisible();
    await dialog.getByLabel('User id').fill(FRIEND);
    await dialog.getByLabel('Role').selectOption('editor');
    await dialog.getByRole('button', { name: 'Add' }).click();
    const row = dialog.getByTestId('collaborator');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(FRIEND);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/share.png` });

    await row.getByLabel(`Role of ${FRIEND}`).selectOption('viewer');
    await expect
      .poll(
        async () => (await api('GET', `/design-projects/${project.id}/collaborators`)).data[0].role,
      )
      .toBe('viewer');

    await dialog.getByLabel('User id').fill(FRIEND);
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog.getByRole('alert')).toContainText('already a collaborator');

    await row.getByRole('button', { name: `Remove ${FRIEND}` }).click();
    await expect(dialog.getByText('Only you can see this project.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  test('lists projects by scope and duplicates one from the list', async () => {
    await page.goto('/projects');
    await expect(page.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('link', { name: 'Shared with me' }).click();
    await expect(page).toHaveURL(/scope=shared/);
    await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Mine' }).click();
    await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();

    await page.getByRole('button', { name: `Duplicate ${title}` }).click();
    await expect(page).toHaveURL(/\/studio\//);
    await expect(page.getByLabel('Project title')).toHaveValue(`Copy of ${title}`);
  });

  test('logged no errors in the browser console', () => {
    // 409 is the planned "already a collaborator" response.
    const planned = /^Failed to load resource: the server responded with a status of 409\b/;
    expect(consoleErrors.filter((e) => !planned.test(e))).toEqual([]);
  });
});

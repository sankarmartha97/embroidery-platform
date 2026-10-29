// S9-06: publish flow end to end. A designer exports, declares rights and submits; a moderator
// requests changes; the designer resubmits; the moderator approves. E2E_MODERATOR_TOKEN is a dev
// token for a user with staff.moderator (CI: 0190f0a0-…de13).
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const MODERATOR_TOKEN = process.env.E2E_MODERATOR_TOKEN;
const SHOTS = process.env.E2E_SCREENSHOTS;
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';

test.describe.configure({ mode: 'serial' });

test.describe('Publish a design', () => {
  test.skip(!TOKEN || !MODERATOR_TOKEN, 'E2E_TOKEN and E2E_MODERATOR_TOKEN are needed');
  let designer;
  let moderator;
  let project;
  const title = `Publish ${Date.now()}`;
  const consoleErrors = [];

  async function pageFor(browser, baseURL, token) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: 'emb_session', value: token, url: baseURL, httpOnly: true }]);
    const page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    return page;
  }
  const api = async (page, method, path, data, headers) =>
    (await page.request.fetch(`/api/v1${path}`, { method, data, headers })).json();

  const queueItem = () =>
    moderator
      .getByTestId('queue-item')
      .filter({ has: moderator.getByRole('heading', { name: title }) });

  test.beforeAll(async ({ browser, baseURL }) => {
    designer = await pageFor(browser, baseURL, TOKEN);
    moderator = await pageFor(browser, baseURL, MODERATOR_TOKEN);
    await designer.goto('/projects');
    project = await api(designer, 'POST', '/design-projects', {
      title,
      machineProfileId: TAJIMA_100,
    });
    await api(designer, 'PUT', `/design-projects/${project.id}/draft`, heartDocument(), {
      'If-Match': '"0"',
    });
  });
  test.afterAll(async () => {
    await designer.context().close();
    await moderator.context().close();
  });

  test('SEC-T11: a designer cannot open the moderation queue', async () => {
    await designer.goto('/moderation');
    await expect(designer.getByText('The moderation queue is for moderators.')).toBeVisible();
    await designer.goto('/projects');
    await expect(designer.getByRole('link', { name: 'Moderation' })).toHaveCount(0);
  });

  test('blocks submission until rights and a validated export exist', async () => {
    await designer.goto(`/studio/${project.id}`);
    // Export (validate first, then write the DST) so the version has a passing export.
    await designer.getByRole('button', { name: 'Export' }).click();
    const exportDialog = designer.getByTestId('export-dialog');
    await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = designer.waitForEvent('download', { timeout: 30_000 });
    await exportDialog.getByRole('button', { name: 'Export anyway' }).click({ timeout: 30_000 });
    await download;

    await designer.getByRole('button', { name: 'Submit', exact: true }).click();
    const dialog = designer.getByRole('dialog', { name: 'Submit for review' });
    const submit = dialog.getByRole('button', { name: 'Submit for review' });
    const checklist = dialog.getByRole('list', { name: 'Before you submit' });
    await expect(checklist.locator('.check-ok')).toHaveCount(2); // export + validated
    await expect(submit).toBeDisabled();

    await dialog.getByLabel('Where does the artwork come from?').selectOption('licensed');
    await dialog.getByLabel('Rights holder').fill('Rose Studio Ltd');
    await dialog.getByLabel('Licence id or URL').fill('https://example.com/licence/42');
    await dialog.getByRole('button', { name: 'Declare rights' }).click();
    await expect(dialog.getByTestId('rights-row')).toContainText('Rose Studio Ltd');
    await expect(checklist.locator('.check-ok')).toHaveCount(3);
    await dialog.getByLabel(/I accept the creator terms/).check();
    await expect(submit).toBeEnabled();
    if (SHOTS) await designer.screenshot({ path: `${SHOTS}/submit.png` });
    await submit.click();

    await expect(dialog).toBeHidden();
    await expect(designer.getByTestId('publication-status')).toHaveText('Submitted');
    await expect(designer.getByRole('button', { name: 'Submit', exact: true })).toHaveCount(0);
  });

  test('a moderator requests changes with a reason', async () => {
    await moderator.goto('/projects');
    await moderator.getByRole('link', { name: 'Moderation' }).click();
    await expect(queueItem()).toBeVisible();
    await expect(queueItem()).toContainText('Rose Studio Ltd');
    await expect(queueItem()).toContainText('Validation: Warnings');
    if (SHOTS) await moderator.screenshot({ path: `${SHOTS}/moderation.png` });
    await queueItem().getByRole('button', { name: 'Request changes' }).click();
    await queueItem().getByLabel('What should change?').fill('Please add a description.');
    await queueItem().getByRole('button', { name: 'Send request' }).click();
    await expect(queueItem()).toHaveCount(0);

    await designer.reload();
    await expect(designer.getByTestId('publication-status')).toHaveText(
      'Changes requested · Please add a description.',
    );
  });

  test('the designer resubmits and the moderator approves', async () => {
    await designer.getByRole('button', { name: 'Submit', exact: true }).click();
    const dialog = designer.getByRole('dialog', { name: 'Submit for review' });
    await dialog.getByLabel(/I accept the creator terms/).check();
    await dialog.getByRole('button', { name: 'Submit for review' }).click();
    await expect(designer.getByTestId('publication-status')).toHaveText('Submitted');

    await moderator.reload();
    await queueItem().getByRole('button', { name: 'Approve' }).click();
    await expect(queueItem()).toHaveCount(0);
    await moderator.getByRole('link', { name: 'Approved' }).click();
    await expect(queueItem()).toBeVisible();

    await designer.reload();
    await expect(designer.getByTestId('publication-status')).toHaveText('Published');
    const detail = await api(designer, 'GET', `/design-projects/${project.id}`);
    expect(detail.status).toBe('published');
    expect(detail.visibility).toBe('marketplace');
  });

  test('logged no errors in the browser console', () => {
    expect(consoleErrors).toEqual([]);
  });
});

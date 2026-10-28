// S10-03: role-based UI. A viewer collaborator and a moderator open someone else's project and get
// a read-only Studio: no sharing, submitting, restoring, editing or jobs. The API enforces the same
// rules; this checks the UI does not offer what would be refused.
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const FRIEND_TOKEN = process.env.E2E_FRIEND_TOKEN;
const MODERATOR_TOKEN = process.env.E2E_MODERATOR_TOKEN;
const FRIEND = process.env.E2E_FRIEND ?? '0190f0a0-0000-7000-8000-00000000de12';
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';

test.describe('Role-based Studio', () => {
  test.skip(
    !TOKEN || !FRIEND_TOKEN || !MODERATOR_TOKEN,
    'needs owner, friend and moderator tokens',
  );
  let projectId;

  test.beforeAll(async ({ playwright, baseURL }) => {
    const owner = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: `emb_session=${TOKEN}` },
    });
    const project = await (
      await owner.post('/api/v1/design-projects', {
        data: { title: `Roles ${Date.now()}`, machineProfileId: TAJIMA_100 },
      })
    ).json();
    projectId = project.id;
    await owner.put(`/api/v1/design-projects/${projectId}/draft`, {
      data: heartDocument(),
      headers: { 'If-Match': '"0"' },
    });
    await owner.post(`/api/v1/design-projects/${projectId}/versions`, { data: { label: 'v1' } });
    const shared = await owner.post(`/api/v1/design-projects/${projectId}/collaborators`, {
      data: { userId: FRIEND, role: 'viewer' },
    });
    expect(shared.status()).toBe(201);
    await owner.dispose();
  });

  for (const [who, token] of [
    ['a viewer collaborator', () => FRIEND_TOKEN],
    ['a moderator', () => MODERATOR_TOKEN],
  ]) {
    test(`${who} gets a read-only Studio`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addCookies([
        { name: 'emb_session', value: token(), url: baseURL, httpOnly: true },
      ]);
      const page = await context.newPage();
      await page.goto(`/studio/${projectId}`);
      await expect(page.locator('[data-object-id="outline"]')).toBeVisible();

      await expect(page.getByLabel('Project title')).toBeDisabled();
      for (const name of ['Share', 'Submit']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
      for (const name of ['Digitize', 'Export']) {
        await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
      }
      await expect(page.getByRole('button', { name: /^Validate/ })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Rectangle (R)' })).toBeDisabled();

      await page.getByRole('button', { name: 'History' }).click();
      const history = page.getByRole('dialog', { name: 'Version history' });
      await expect(history.getByTestId('version-row')).toHaveCount(1);
      await expect(history.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
      await expect(history.getByRole('button', { name: 'Save version' })).toHaveCount(0);
      await context.close();
    });
  }
});

// S10-03: WCAG 2.1 A/AA checks (axe) on the key screens and dialogs, in light and dark themes.
// The Studio canvas keeps its fixed dark artwork colours (design-system.md), so contrast inside the
// SVG artwork itself is excluded; its rulers and controls are checked.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { heartDocument } from '../../test/helpers/documents.js';

const TOKEN = process.env.E2E_TOKEN;
const MODERATOR_TOKEN = process.env.E2E_MODERATOR_TOKEN;
const TAJIMA_100 = '00000000-0000-7000-8000-000000000101';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Violations as readable lines, so a failure says what to fix. */
async function audit(page, name) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude('.design-artwork')
    .analyze();
  return violations.map(
    (v) =>
      `${name}: ${v.id} (${v.impact}) ${v.help} → ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
}

for (const scheme of ['light', 'dark']) {
  test.describe(`Accessibility (${scheme})`, () => {
    test.skip(!TOKEN, 'E2E_TOKEN is not set');
    test.use({ colorScheme: scheme });

    test('sign-in, projects, Studio and its dialogs', async ({ browser, baseURL }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      const found = [];

      await page.goto('/sign-in');
      found.push(...(await audit(page, 'sign-in')));

      await context.addCookies([
        { name: 'emb_session', value: TOKEN, url: baseURL, httpOnly: true },
      ]);
      await page.goto('/projects');
      found.push(...(await audit(page, 'projects')));

      const project = await (
        await page.request.post('/api/v1/design-projects', {
          data: { title: `A11y ${Date.now()}`, machineProfileId: TAJIMA_100 },
        })
      ).json();
      await page.request.put(`/api/v1/design-projects/${project.id}/draft`, {
        data: heartDocument(),
        headers: { 'If-Match': '"0"' },
      });
      await page.goto(`/studio/${project.id}`);
      await expect(page.getByTestId('canvas')).toBeVisible();
      await page.locator('.sequence-name').first().click();
      found.push(...(await audit(page, 'studio')));

      for (const [button, name] of [
        ['Export', 'export dialog'],
        ['History', 'history dialog'],
        ['Share', 'share dialog'],
        ['Submit', 'submit dialog'],
      ]) {
        await page.getByRole('button', { name: button, exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.waitForTimeout(300); // let the dialog finish loading its lists
        found.push(...(await audit(page, name)));
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toBeHidden();
      }

      await page.getByRole('button', { name: 'Simulate' }).click();
      await expect(page.getByTestId('simulator')).toBeVisible({ timeout: 30_000 });
      found.push(...(await audit(page, 'simulator')));
      await page.getByRole('button', { name: 'Back to editing' }).click();

      if (MODERATOR_TOKEN) {
        await context.clearCookies();
        await context.addCookies([
          { name: 'emb_session', value: MODERATOR_TOKEN, url: baseURL, httpOnly: true },
        ]);
        await page.goto('/moderation?status=approved');
        found.push(...(await audit(page, 'moderation')));
      }

      await context.close();
      expect(found, found.join('\n')).toEqual([]);
    });
  });
}

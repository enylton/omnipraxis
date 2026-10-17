import { expect, test } from '@playwright/test';

import { db, prepare, reset } from '../../functions/test/portal-fixtures.ts';

test.beforeAll(prepare);
test.beforeEach(reset);

test('an unconfigured remote deployment fails before Firebase connections or scene downloads', async ({
  page,
}) => {
  const cloud: string[] = [];
  page.on('request', (request) => {
    if (/googleapis\.com|firebaseio\.com|cloudfunctions\.net/.test(request.url()))
      cloud.push(request.url());
  });
  await page.route('https://portal.example.test/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `http://127.0.0.1:4200${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
  await page.goto('https://portal.example.test/');
  await expect(page.locator('portal-app')).toContainText(
    'Configuration must be completed by the operator',
  );
  expect(cloud).toEqual([]);
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('public revision replacement and suspension close the viewer; local binary URLs are absent', async ({
  page,
}) => {
  await page.goto('/base');
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
    timeout: 90_000,
  });
  const current = await db.doc('publicScenes/base').get();
  const next = structuredClone(current.get('descriptor'));
  next.revisionId = 'replacement';
  for (const asset of Object.values(next.assets) as { path: string }[])
    asset.path = asset.path.replace('/legacy-v1/', '/replacement/');
  await db
    .doc('publicScenes/base')
    .update({ publishedRevisionId: 'replacement', descriptor: next });
  await expect(page.getByRole('status')).toContainText('scene has changed');
  await expect(page.locator('canvas')).toHaveCount(0);
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: false });
  await expect(page.getByRole('button', { name: 'Reopen scene' })).toBeDisabled();
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: true });
  await expect(page.getByRole('button', { name: 'Reopen scene' })).toBeEnabled();
  await expect(page.locator('canvas')).toHaveCount(0);
  for (const path of [
    '/scenes/drill-rig/splats.spz',
    '/scenes/base/splats.spz',
    '/scenes/circuit-breaker/splats-lod.rad',
    '/assets/manometro.glb',
  ])
    expect((await page.request.get(path)).status()).toBe(404);
});

test('public replacement during acquisition prevents stale mounting and never fetches every RAD page', async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let pages = 0;
  page.on('request', (request) => {
    if (decodeURIComponent(request.url()).includes('.radc')) pages++;
  });
  await page.route(/\/deliverAsset\?path=/, async (route) => {
    requested();
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto('/circuit-breaker');
  await pending;
  const scene = await db.doc('publicScenes/circuit-breaker').get();
  const descriptor = structuredClone(scene.get('descriptor'));
  descriptor.revisionId = 'replaced';
  for (const asset of Object.values(descriptor.assets) as { path: string }[])
    asset.path = asset.path.replace('/legacy-v1/', '/replaced/');
  await scene.ref.update({ publishedRevisionId: 'replaced', descriptor });
  await expect(page.getByRole('status')).toContainText('scene has changed');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(pages).toBe(0);
});

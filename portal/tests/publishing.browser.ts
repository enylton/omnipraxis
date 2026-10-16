import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { db, password, prepare, reset } from '../../functions/test/portal-fixtures.ts';

import type { Page } from '@playwright/test';

test.beforeAll(prepare);
test.beforeEach(reset);
test.use({ actionTimeout: 15000 });
function png() {
  const chunk = (name: string, b: Buffer) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length);
    const data = Buffer.concat([Buffer.from(name), b]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(data));
    return Buffer.concat([h, data, c]);
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(1);
  h.writeUInt32BE(1, 4);
  h[8] = 8;
  h[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', h),
    chunk('IDAT', deflateSync(Buffer.from([0, 20, 100, 160, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function login(page: Page, uid: string) {
  await page.getByLabel('Email', { exact: true }).fill(`${uid}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function administrator(page: Page) {
  await page.goto('/organizations/alpha/admin');
  await login(page, 'admin');
  await expect(page.getByRole('button', { name: 'Create scene', exact: true })).toBeEnabled();
}
async function create(page: Page, id: string) {
  await page.getByLabel('Scene ID', { exact: true }).fill(id);
  await page.getByLabel('Scene title', { exact: true }).fill('Uploaded environment');
  await page.getByRole('button', { name: 'Create scene', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Scene created');
  await page.getByRole('button', { name: 'Uploaded environment · draft', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Upload environment', exact: true }),
  ).toBeVisible();
}
async function files(page: Page, invalid = false) {
  await page.getByLabel('SPZ file', { exact: true }).setInputFiles({
    name: 'splats.spz',
    mimeType: 'application/octet-stream',
    buffer: invalid ? Buffer.from('bad-spz') : await readFile('public/scenes/drill-rig/splats.spz'),
  });
  await page
    .getByLabel('Collider GLB', { exact: true })
    .setInputFiles('public/scenes/drill-rig/colliders.glb');
  await page
    .getByLabel('Thumbnail PNG', { exact: true })
    .setInputFiles({ name: 'thumbnail.png', mimeType: 'image/png', buffer: png() });
}
test('administrator invitation → assigned upload → pause/resume → validation/preview → publish/replace/rollback → access removal', async ({
  page,
  browser,
}) => {
  test.setTimeout(300000);
  await administrator(page);
  await page.getByLabel('Invitation email', { exact: true }).fill('outsider@example.test');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const link = await page.getByLabel('Invitation link — copy and share privately').inputValue();
  expect(link).toContain('/invite#');
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  try {
    await viewer.goto(link);
    await login(viewer, 'outsider');
    await viewer.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(viewer).toHaveURL(/organizations\/alpha\/scenes$/);
    await create(page, 'published-environment');
    await page.getByRole('combobox', { name: 'Access', exact: true }).selectOption('assigned');
    await page.getByLabel('Assigned member UIDs, separated by commas').fill('outsider');
    await page.getByRole('button', { name: 'Save access', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Scene access saved');
    await files(page);
    let acknowledge!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((r) => {
      acknowledge = r;
    });
    const paused = new Promise<void>((r) => {
      release = r;
    });
    await page.route('**/appendChunk', async (route) => {
      acknowledge();
      await paused;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Start upload', exact: true }).click();
    await requested;
    await page.getByRole('button', { name: 'Pause upload', exact: true }).click();
    release();
    await expect(page.getByRole('button', { name: 'Resume upload', exact: true })).toBeEnabled();
    await page.unrouteAll({ behavior: 'wait' });
    const progress = await page
      .getByRole('progressbar', { name: 'Upload progress' })
      .getAttribute('value');
    expect(Number(progress)).toBeGreaterThan(0);
    expect(Number(progress)).toBeLessThan(100);
    await page.getByRole('button', { name: 'Resume upload', exact: true }).click();
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100', { timeout: 90000 });
    await page.getByRole('button', { name: 'Validate uploaded files', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Preview revision', exact: true })).toBeVisible({
      timeout: 90000,
    });
    const first = (
      await db
        .collection('organizations/alpha/scenes/published-environment/revisions')
        .where('status', '==', 'ready')
        .get()
    ).docs[0].id;
    await page.getByRole('link', { name: 'Preview revision', exact: true }).click();
    await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90000 });
    await expect(page.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
      timeout: 90000,
    });
    await page.getByRole('link', { name: '← Catalog' }).click();
    await expect(page).toHaveURL(/\/alpha\/admin$/);
    await page.getByRole('button', { name: 'Uploaded environment · draft', exact: true }).click();
    await page.getByRole('button', { name: 'Publish / rollback', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Revision published');
    await viewer.reload();
    await viewer.getByRole('link', { name: /Uploaded environment/ }).click();
    await expect(viewer.locator('canvas')).toHaveCount(1, { timeout: 90000 });
    await expect(viewer.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
      timeout: 90000,
    });
    await files(page);
    await page.getByRole('button', { name: 'Start upload', exact: true }).click();
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100', { timeout: 90000 });
    await page.getByRole('button', { name: 'Validate uploaded files', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Preview revision', exact: true })).toHaveCount(2, {
      timeout: 90000,
    });
    await page.getByRole('button', { name: 'Publish / rollback', exact: true }).click();
    await expect(viewer.getByRole('status')).toContainText('scene has changed');
    await expect(viewer.locator('canvas')).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Reopen scene' }).click();
    await expect(viewer.locator('canvas')).toHaveCount(1, { timeout: 90000 });
    await page
      .locator('.admin-row')
      .filter({ hasText: first })
      .getByRole('button', { name: 'Publish / rollback', exact: true })
      .click();
    await expect(viewer.getByRole('status')).toContainText('scene has changed');
    await viewer.getByRole('button', { name: 'Reopen scene' }).click();
    await expect(viewer.locator('canvas')).toHaveCount(1, { timeout: 90000 });
    await page.getByRole('button', { name: 'Archive scene', exact: true }).click();
    await expect(viewer.getByRole('status')).toContainText('Access denied');
    await page
      .getByRole('combobox', { name: 'Status for outsider@example.test', exact: true })
      .selectOption('suspended');
    await page
      .locator('#members .admin-row')
      .filter({ hasText: 'outsider@example.test' })
      .getByRole('button', { name: 'Save member' })
      .click();
    await expect(page.getByRole('status')).toContainText('Membership saved');
    await page.screenshot({ path: 'build/publishing-admin.png', fullPage: true });
    expect((await db.doc('organizations/alpha/members/outsider').get()).get('status')).toBe(
      'suspended',
    );
  } finally {
    await viewerContext.close();
  }
});
test('last-admin protection, invitation revocation, invalid upload and cancellation stay recoverable', async ({
  page,
}) => {
  await administrator(page);
  await page.getByRole('link', { name: 'Members', exact: true }).click();
  await expect(page).toHaveURL(/\/organizations\/alpha\/admin#members$/);
  await page
    .getByRole('combobox', { name: 'Status for admin@example.test', exact: true })
    .selectOption('removed');
  await page
    .locator('#members .admin-row')
    .filter({ hasText: 'admin@example.test' })
    .getByRole('button', { name: 'Save member' })
    .click();
  await expect(page.getByRole('alert')).toContainText(/last|administrator/i);
  await page.getByLabel('Invitation email', { exact: true }).fill('outsider@example.test');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(page.getByLabel('Invitation link — copy and share privately')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await expect(page.locator('#invitations')).toContainText('revoked');
  await create(page, 'invalid-environment');
  await files(page, true);
  await page.getByRole('button', { name: 'Start upload', exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
  await page.getByRole('button', { name: 'Validate uploaded files', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('gzip SPZ');
  await expect(page.getByRole('link', { name: 'Preview revision', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Upload cancelled');
  expect((await db.doc('system/assetQuota').get()).get('usedBytes')).toBe(0);
});

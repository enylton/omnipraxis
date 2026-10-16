import { expect, test } from '@playwright/test';

import {
  auth,
  db,
  invitation,
  password,
  prepare,
  reset,
} from '../../functions/test/portal-fixtures.ts';

import type { Page } from '@playwright/test';

test.beforeAll(prepare);
test.beforeEach(reset);
async function signIn(page: Page, uid = 'viewer') {
  const login = new URL(page.url()).pathname === '/login';
  await page.getByLabel('Email', { exact: true }).fill(`${uid}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  if (login) await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}
async function openPrivate(page: Page) {
  await page.goto('/organizations/alpha/scenes/drill-rig');
  await signIn(page);
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
    timeout: 90_000,
  });
}
test('anonymous catalog is lightweight; private deep links, foreign organizations and uninvited accounts remain protected', async ({
  page,
}) => {
  const heavy: string[] = [];
  page.on('request', (request) => {
    if (/viewer\/.*\.js|\.(spz|radc?|glb)(\?|$)/.test(request.url())) heavy.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Step into the scene.' })).toBeVisible();
  expect(heavy).toEqual([]);
  await page.goto('/drill-rig');
  await expect(page).toHaveURL(/login\?return=/);
  expect(heavy).toEqual([]);
  await signIn(page, 'outsider');
  await expect(page.getByRole('heading', { name: 'No organizations yet' })).toBeVisible();
  await page.goto('/organizations/alpha/scenes');
  await expect(page.getByRole('alert')).toContainText('Access denied');
  expect(heavy).toEqual([]);
});
test('password sign-in, organization switching, empty catalog, deep-link refresh, Back/Forward and logout', async ({
  page,
}) => {
  await page.goto('/organizations');
  await signIn(page);
  await page.getByRole('link', { name: /Beta Training/ }).click();
  await expect(page.getByRole('heading', { name: 'No scenes available' })).toBeVisible();
  await page.getByRole('link', { name: '← Organizations' }).click();
  await page.getByRole('link', { name: /Alpha Training/ }).click();
  await page.getByRole('link', { name: /Drill Rig/ }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Opening scene…' })).toHaveCount(0, {
    timeout: 90_000,
  });
  await page.reload();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await page.getByRole('link', { name: '← Catalog' }).click();
  await expect(page).toHaveURL(/\/organizations\/alpha\/scenes$/);
  await expect(page.getByRole('heading', { name: 'Scenes', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/organizations\/alpha\/scenes\/drill-rig$/);
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await page.goForward();
  await expect(page).toHaveURL(/\/organizations\/alpha\/scenes$/);
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('link', { name: /Drill Rig/ }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('canvas')).toHaveCount(0);
});
test('membership suspension and assignment removal close an active viewer', async ({ page }) => {
  await openPrivate(page);
  await db.doc('organizations/alpha/members/viewer').update({ status: 'suspended' });
  await expect(page.getByRole('status')).toContainText('Access denied');
  await expect(page.locator('canvas')).toHaveCount(0);
  await db.doc('organizations/alpha/members/viewer').update({ status: 'active' });
  await page.getByRole('button', { name: 'Reopen scene' }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await db.doc('organizations/alpha/scenes/drill-rig').update({ assignedUserIds: [] });
  await expect(page.getByRole('status')).toContainText('Access denied');
  await expect(page.locator('canvas')).toHaveCount(0);
});
test('replacement while viewing requires explicit reopening; suspension does not retry after resuming', async ({
  page,
}) => {
  await openPrivate(page);
  await db.doc('organizations/alpha/scenes/drill-rig').update({ publishedRevisionId: 'r2' });
  await expect(page.getByRole('status')).toContainText('scene has changed');
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reopen scene' }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: false });
  await expect(page.getByRole('status')).toContainText('temporarily unavailable');
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reopen scene' })).toBeDisabled();
  await db.doc('publicSettings/delivery').update({ downloadsEnabled: true });
  await expect(page.getByRole('button', { name: 'Reopen scene' })).toBeEnabled();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reopen scene' }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
});
for (const change of ['replacement', 'suspension', 'logout'] as const)
  test(`${change} during a blocked asset download cannot mount a stale viewer`, async ({
    page,
  }) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const pending = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route('**/v0/b/**/o/**', async (route) => {
      requested();
      await blocked;
      await route.continue().catch(() => {});
    });
    await page.goto('/organizations/alpha/scenes/drill-rig');
    await signIn(page);
    await pending;
    if (change === 'replacement')
      await db.doc('organizations/alpha/scenes/drill-rig').update({ publishedRevisionId: 'r2' });
    else if (change === 'suspension')
      await db.doc('organizations/alpha/members/viewer').update({ status: 'suspended' });
    else await page.getByRole('button', { name: 'Sign out' }).click();
    if (change !== 'logout')
      await expect(page.getByRole('heading', { name: 'Scene closed' })).toBeVisible();
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.locator('canvas')).toHaveCount(0);
  });
test('invitation secret is scrubbed, wrong recipient is denied, matching verified account can join', async ({
  page,
}) => {
  const invite = await invitation();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`/invite#orgId=alpha&invitationId=${invite.invitationId}&token=${invite.token}`);
  await expect(page).toHaveURL(/\/invite$/);
  await signIn(page, 'viewer');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('alert')).toContainText('Access denied');
  await page.getByRole('button', { name: 'Use another account' }).click();
  await signIn(page, 'outsider');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/organizations\/alpha\/scenes$/);
  expect((await db.doc('organizations/alpha/members/outsider').get()).get('status')).toBe('active');
  expect(requests.every((url) => !url.includes(invite.token))).toBe(true);
  expect(
    await page.evaluate(
      (secret) =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(
          secret,
        ),
      invite.token,
    ),
  ).toBe(false);
});
test('invited signup verifies email before accepting; reset-password action is available', async ({
  page,
}) => {
  const email = `new-${Date.now()}@example.test`;
  const invite = await invitation(email);
  await page.goto(`/invite#orgId=alpha&invitationId=${invite.invitationId}&token=${invite.token}`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create invited account' }).click();
  await expect(page.getByRole('button', { name: 'I have verified my email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  const oob = (await (
    await fetch('http://127.0.0.1:9199/emulator/v1/projects/demo-omnipraxis/oobCodes')
  ).json()) as { oobCodes: { email: string; oobCode: string; requestType: string }[] };
  const code = oob.oobCodes.findLast(
    (item) => item.email === email && item.requestType === 'VERIFY_EMAIL',
  )!;
  expect(code).toBeTruthy();
  const response = await fetch(
    'http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:update?key=demo-omnipraxis',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: code.oobCode }),
    },
  );
  expect(response.ok).toBe(true);
  await page.getByRole('button', { name: 'I have verified my email' }).click();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/organizations\/alpha\/scenes$/);
  const user = await auth.getUserByEmail(email);
  expect((await db.doc(`organizations/alpha/members/${user.uid}`).get()).get('status')).toBe(
    'active',
  );
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('status')).toContainText('reset email');
});
for (const slug of ['base', 'circuit-breaker', 'pressure-gauge'])
  test(`anonymous ${slug} demo renders its retained scene`, async ({ page }) => {
    const errors: string[] = [];
    const binaries: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (/\.(spz|radc?|glb)(\?|$)/.test(response.url()) && response.ok())
        binaries.push(response.url());
    });
    await page.goto(`/${slug}`);
    await expect(page.locator('canvas')).toHaveCount(1, { timeout: 90_000 });
    await expect
      .poll(
        () =>
          binaries.some(
            (url) =>
              url.includes(`scenes/${slug}/`) && url.endsWith(slug === 'base' ? '.spz' : '.radc'),
          ),
        { timeout: 90_000 },
      )
      .toBe(true);
    await expect(page.getByRole('heading', { name: 'Scene closed' })).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.getByRole('link', { name: '← Catalog' }).click();
    await expect(page.locator('canvas')).toHaveCount(0);
  });
test('responsive catalog has no horizontal overflow and admin route requires an administrator', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.screenshot({ path: 'build/portal-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/organizations/alpha/admin');
  await signIn(page);
  await expect(page).toHaveURL(/\/organizations$/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'admin');
  await page.goto('/organizations/alpha/admin');
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
});

test('Google popup linking and password sign-in keep the same invited UID and organizations', async ({
  page,
  context,
}) => {
  // External widget styling is unnecessary; the actual Auth emulator handler is used.
  await context.route(/https:\/\/(unpkg.com|fonts.googleapis.com|fonts.gstatic.com)\//, (route) =>
    route.abort(),
  );
  await page.goto('/organizations');
  await signIn(page);
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  const popupReady = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Link Google to this account' }).click();
  const popup = await popupReady;
  await popup.getByRole('button', { name: 'Add new account' }).click();
  await popup.locator('#email-input').fill('viewer@example.test');
  await popup.locator('#sign-in').click();
  await expect(page.getByRole('status')).toContainText('Account updated');
  expect((await auth.getUserByEmail('viewer@example.test')).uid).toBe('viewer');
  expect(
    (await auth.getUser('viewer')).providerData.some(
      (provider) => provider.providerId === 'google.com',
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  const nextPopup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const google = await nextPopup;
  await google.getByText('viewer@example.test', { exact: true }).click();
  await expect(page.getByRole('link', { name: /Alpha Training/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Beta Training/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page);
  await expect(page.getByRole('link', { name: /Alpha Training/ })).toBeVisible();
});

test('keyboard, pointer lock, touch joystick and standard gamepad remain attached only to the viewer', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const controls = { polls: 0, axes: [0, 0, 0, 0] };
    Object.assign(window, { portalTestControls: controls });
    Object.defineProperty(navigator, 'getGamepads', {
      value: () => {
        controls.polls++;
        return [
          {
            connected: true,
            index: 0,
            mapping: 'standard',
            axes: controls.axes,
            buttons: Array.from({ length: 17 }, () => ({
              pressed: false,
              touched: false,
              value: 0,
            })),
          },
        ];
      },
    });
  });
  await openPrivate(page);
  const stage = await page.locator('.viewer-stage').boundingBox();
  const canvas = await page.locator('canvas').boundingBox();
  expect(canvas!.height).toBeGreaterThanOrEqual(stage!.height - 1);
  expect(canvas!.width).toBeGreaterThanOrEqual(stage!.width - 1);
  await page.locator('canvas').click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');
  await page.keyboard.down('KeyW');
  await page.mouse.move(30, 20);
  await page.keyboard.up('KeyW');
  await page.evaluate(() => document.exitPointerLock());
  await expect.poll(() => page.evaluate(() => document.pointerLockElement)).toBeNull();
  await page.locator('canvas').dispatchEvent('pointerdown', {
    pointerId: 7,
    pointerType: 'touch',
    clientX: 40,
    clientY: 500,
  });
  await expect(page.locator('.touch-joystick')).toBeVisible();
  await page.locator('canvas').dispatchEvent('pointermove', {
    pointerId: 7,
    pointerType: 'touch',
    clientX: 70,
    clientY: 480,
  });
  await expect(page.locator('.touch-joystick-knob')).toHaveCSS('transform', /matrix/);
  await page
    .locator('canvas')
    .dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: 70, clientY: 480 });
  await expect(page.locator('.touch-joystick')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { portalTestControls: { polls: number } }).portalTestControls.polls,
      ),
    )
    .toBeGreaterThan(2);
  await page.evaluate(() => {
    (window as unknown as { portalTestControls: { axes: number[] } }).portalTestControls.axes = [
      0.5, -0.5, 0.25, -0.25,
    ];
  });
  await page.screenshot({ path: 'build/portal-viewer.png' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('canvas,.touch-controls-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('expired and revoked invitations show a recoverable error without granting membership', async ({
  page,
}) => {
  for (const status of ['expired', 'revoked']) {
    const invite = await invitation();
    await db.doc(`organizations/alpha/invitations/${invite.invitationId}`).update({ status });
    await page.goto(
      `/invite#orgId=alpha&invitationId=${invite.invitationId}&token=${invite.token}`,
    );
    if (status === 'expired') await signIn(page, 'outsider');
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page.getByRole('alert')).toContainText('expired, revoked, or already used');
    expect((await db.doc('organizations/alpha/members/outsider').get()).exists).toBe(false);
  }
});

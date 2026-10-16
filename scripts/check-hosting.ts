import assert from 'node:assert/strict';

if (process.env.GCLOUD_PROJECT !== 'demo-omnipraxis')
  throw new Error('Hosting checks require the dedicated demo emulator.');
for (const path of [
  '/',
  '/pressure-gauge',
  '/organizations/alpha/scenes/drill-rig',
  '/scenes/drill-rig/splats.spz',
  '/scenes/base/splats.spz',
]) {
  const response = await fetch(`http://127.0.0.1:5000${path}`);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type')?.includes('text/html'));
  assert.ok(
    response.headers.get('cache-control')?.includes('no-store'),
    JSON.stringify({ path, headers: Object.fromEntries(response.headers) }),
  );
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((await response.text()).includes('<portal-app>'));
}
console.log(
  'Hosting emulator serves Angular deep links and no scene binaries, with no-store/nosniff headers.',
);

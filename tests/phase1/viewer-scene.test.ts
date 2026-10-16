import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseViewerScene } from '../../src/viewer/scene.ts';

import type { ViewerScene } from '../../src/viewer/scene.ts';

const valid = (): ViewerScene => ({
  template: 'environment',
  sessionId: 'local viewing session',
  assets: {
    splatsUrl: 'blob:http://localhost/splats',
    splatsFormat: 'spz',
    collidersUrl: 'asset://localhost/colliders.glb',
  },
  spawn: { position: [0, 1, 0], yaw: 0, pitch: 0 },
});

test('accepts a render specification without cloud identities, paths, or checksums', () => {
  const parsed = parseViewerScene(valid());
  assert.equal(parsed.sessionId, 'local viewing session');
  assert.equal(parsed.assets.collidersUrl, 'asset://localhost/colliders.glb');
});

test('captures render inputs while preserving a generic page resolver', () => {
  const original = valid();
  const position: [number, number, number] = [0, 1, 0];
  original.spawn.position = position;
  original.assets.splatsFormat = 'rad';
  original.assets.resolvePageUrl = (filename) => `https://example.com/pages/${filename}`;
  const parsed = parseViewerScene({ ...original, scope: { kind: 'organization' } });
  original.assets.splatsUrl = 'changed';
  position[0] = 99;
  original.spawn.yaw = 1;
  assert.equal(parsed.assets.splatsUrl, 'blob:http://localhost/splats');
  assert.deepEqual(parsed.spawn, { position: [0, 1, 0], yaw: 0, pitch: 0 });
  assert.equal(parsed.assets.resolvePageUrl, original.assets.resolvePageUrl);
  assert.equal(
    parsed.assets.resolvePageUrl?.('chunk.radc'),
    'https://example.com/pages/chunk.radc',
  );
  assert.equal('scope' in parsed, false);
});

for (const [label, invalid] of [
  ['cloud descriptor', { schemaVersion: 1, kind: 'environment-v1' }],
  ['unknown template', { ...valid(), template: 'training' }],
  ['missing session label', { ...valid(), sessionId: ' ' }],
  ['unsupported splat format', { ...valid(), assets: { ...valid().assets, splatsFormat: 'ply' } }],
  ['empty asset URL', { ...valid(), assets: { ...valid().assets, collidersUrl: '' } }],
  [
    'invalid page resolver',
    { ...valid(), assets: { ...valid().assets, resolvePageUrl: '/pages/' } },
  ],
  ['non-finite position', { ...valid(), spawn: { ...valid().spawn, position: [0, Infinity, 0] } }],
  ['sparse position', { ...valid(), spawn: { ...valid().spawn, position: new Array(3) } }],
  ['non-finite orientation', { ...valid(), spawn: { ...valid().spawn, pitch: NaN } }],
] as const) {
  test(`rejects ${label} before rendering`, () => {
    assert.throws(() => parseViewerScene(invalid), /invalid viewer scene/);
  });
}

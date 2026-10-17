import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSceneDescriptor } from '../../src/contracts/scene.ts';

const valid = () => ({
  schemaVersion: 1,
  kind: 'environment-v1',
  sceneId: 'drill-rig',
  revisionId: 'r1',
  scope: { kind: 'organization', organizationId: 'org1' },
  assets: {
    splats: {
      path: 'organizations/org1/scenes/drill-rig/revisions/r1/splats.spz',
      format: 'spz',
      bytes: 42,
      sha256: 'a'.repeat(64),
    },
    colliders: {
      path: 'organizations/org1/scenes/drill-rig/revisions/r1/colliders.glb',
      format: 'glb',
      bytes: 42,
      sha256: 'b'.repeat(64),
    },
  },
  spawn: { position: [0, 1, 0], yaw: 0, pitch: 0 },
});

test('captures validated descriptors without retaining caller mutations', () => {
  const original = valid();
  const parsed = parseSceneDescriptor(original);
  original.spawn.position[0] = 99;
  assert.equal(parsed.spawn.position[0], 0);
});

for (const [label, mutate] of [
  [
    'unknown schema',
    (value: ReturnType<typeof valid>) => {
      value.schemaVersion = 2;
    },
  ],
  [
    'non-finite spawn',
    (value: ReturnType<typeof valid>) => {
      value.spawn.yaw = NaN;
    },
  ],
  [
    'cross-organization path',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.path = value.assets.splats.path.replace('org1', 'org2');
    },
  ],
  [
    'cross-revision path',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.path = value.assets.splats.path.replace('/r1/', '/r2/');
    },
  ],
  [
    'path traversal',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.path = value.assets.splats.path.replace('splats.spz', '../splats.spz');
    },
  ],
  [
    'remote URL',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.path = 'https://example.com/splats.spz';
    },
  ],
  [
    'oversized asset',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.bytes = 101 * 1024 * 1024;
    },
  ],
  [
    'invalid checksum',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.sha256 = 'not-a-checksum';
    },
  ],
  [
    'private paging',
    (value: ReturnType<typeof valid>) => {
      value.assets.splats.format = 'rad';
      value.assets.splats.path = value.assets.splats.path.replace('.spz', '.rad');
    },
  ],
] as const) {
  test(`rejects ${label}`, () => {
    const value = valid();
    mutate(value);
    assert.throws(() => parseSceneDescriptor(value));
  });
}

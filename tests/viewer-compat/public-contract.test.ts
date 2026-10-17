import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProductionConfig } from '../../src/contracts/portalConfig.ts';
import { parsePublicScene } from '../../src/contracts/publicScene.ts';

test('public descriptors reject missing props, paths outside the revision, unknown pages and malformed identities', () => {
  const asset = (name: string) => ({
    path: `public-scenes/base/revisions/r1/${name}`,
    bytes: 1,
    sha256: 'a'.repeat(64),
  });
  const descriptor = {
    schemaVersion: 1,
    kind: 'public-demo-v1',
    sceneId: 'base',
    revisionId: 'r1',
    assets: { 'splats.spz': asset('splats.spz'), 'colliders.glb': asset('colliders.glb') },
  };
  assert.equal(parsePublicScene(descriptor).sceneId, 'base');
  assert.throws(() => parsePublicScene({ ...descriptor, revisionId: undefined }));
  assert.throws(() => parsePublicScene({ ...descriptor, sceneId: 'pressure-gauge' }));
  assert.throws(() =>
    parsePublicScene({
      ...descriptor,
      assets: { ...descriptor.assets, 'other.radc': asset('other.radc') },
    }),
  );
  assert.throws(() =>
    parsePublicScene({
      ...descriptor,
      assets: {
        ...descriptor.assets,
        'colliders.glb': { ...asset('colliders.glb'), path: 'https://example.test/model.glb' },
      },
    }),
  );
});

test('production configuration refuses placeholders, another project and unreviewed origins', () => {
  const config = {
    mode: 'firebase',
    firebase: {
      apiKey: 'reviewed-key',
      projectId: 'omnipraxis-f8141',
      authDomain: 'omnipraxis-f8141.firebaseapp.com',
      storageBucket: 'omnipraxis-f8141.firebasestorage.app',
      appId: 'reviewed-app',
    },
    allowedOrigins: ['https://omnipraxis-f8141.web.app'],
  };
  assert.equal(parseProductionConfig(config).mode, 'firebase');
  assert.throws(() =>
    parseProductionConfig({
      ...config,
      firebase: { ...config.firebase, apiKey: 'REPLACE_WITH_API_KEY' },
    }),
  );
  assert.throws(() =>
    parseProductionConfig({ ...config, firebase: { ...config.firebase, projectId: 'other' } }),
  );
  assert.throws(() => parseProductionConfig({ ...config, allowedOrigins: ['http://localhost'] }));
  assert.throws(() => parseProductionConfig({ ...config, serverSecret: 'must-not-publish' }));
  assert.throws(() =>
    parseProductionConfig({
      ...config,
      firebase: { ...config.firebase, private_key: 'must-not-publish' },
    }),
  );
});

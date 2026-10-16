import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { importLegacyAssets, planLegacyImport } from './legacy-assets.ts';

import type { LegacyScene } from './legacy-assets.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const scene = option('--scene', 'all');
const revision = option('--revision', 'legacy-v1');
const org = option('--org', 'alpha');
const root = option('--source', 'public');
const expectedVersion = Number(option('--expected-version', '0'));
const plans = await Promise.all(
  (scene === 'all' ? ['base', 'circuit-breaker', 'pressure-gauge', 'drill-rig'] : [scene]).map(
    (id) => planLegacyImport(root, id as LegacyScene, revision, org),
  ),
);
console.log(
  JSON.stringify(
    plans.map(({ scene, revision, org, bytes, fingerprint, files }) => ({
      scene,
      revision,
      org,
      bytes,
      fingerprint,
      files: files.length,
    })),
    null,
    2,
  ),
);
if (apply) {
  // Deliberately local-only until the operator has completed cloud/privacy preflight.
  for (const [name, value] of Object.entries({
    GCLOUD_PROJECT: 'demo-omnipraxis',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8280',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9399',
  })) {
    if (process.env[name] && process.env[name] !== value)
      throw new Error('Legacy CLI refuses non-demo endpoints.');
    process.env[name] = value;
  }
  const app = initializeApp(
    { projectId: 'demo-omnipraxis', storageBucket: 'demo-omnipraxis.appspot.com' },
    'legacy-import',
  );
  for (const plan of plans) {
    const result = await importLegacyAssets(
      getFirestore(app),
      getStorage(app).bucket(),
      plan,
      expectedVersion,
    );
    console.log({
      scene: plan.scene,
      revision: plan.revision,
      bytes: result.bytes,
      files: result.files,
    });
  }
  process.exit(0);
} else console.log('Dry run only. Start demo emulators and pass --apply to import.');

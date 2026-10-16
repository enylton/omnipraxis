import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { importLegacyAssets, planLegacyImport } from '../src/legacy-assets.ts';
import { organizationService } from '../src/service.ts';

import type { SceneDescriptor } from '../../src/contracts/scene.ts';
import type { CallableRequest } from 'firebase-functions/v2/https';

const project = 'demo-omnipraxis';
for (const [name, value] of Object.entries({
  GCLOUD_PROJECT: project,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8280',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9399',
})) {
  if (process.env[name] !== value) throw new Error(`Portal fixtures require ${name}=${value}.`);
}
const app = initializeApp(
  { projectId: project, storageBucket: `${project}.appspot.com` },
  'portal-fixtures',
);
export const db = getFirestore(app);
export const auth = getAuth(app);
const service = organizationService(db, auth);
const bucket = getStorage(app).bucket();
export const password = 'Portal-demo-only-123!';
const descriptors = new Map<string, SceneDescriptor>();
const publicDescriptors = new Map<string, unknown>();
export async function prepare() {
  for (const uid of ['admin', 'viewer', 'outsider', 'unverified']) {
    const data = {
      email: `${uid}@example.test`,
      password,
      emailVerified: uid !== 'unverified',
      disabled: false,
    };
    try {
      await auth.updateUser(uid, data);
    } catch {
      await auth.createUser({ uid, ...data });
    }
  }
  await db.doc('publicSettings/delivery').set({ downloadsEnabled: true });
  for (const scene of ['base', 'circuit-breaker', 'pressure-gauge'] as const) {
    const plan = await planLegacyImport(
      fileURLToPath(new URL('../../public', import.meta.url)),
      scene,
      'legacy-v1',
      'alpha',
    );
    const [exists] = await bucket.file(plan.files[0].asset.path).exists();
    if (!exists) {
      const imported = await importLegacyAssets(db, bucket, plan);
      publicDescriptors.set(scene, imported.descriptor);
    } else
      publicDescriptors.set(scene, {
        schemaVersion: 1,
        kind: 'public-demo-v1',
        sceneId: scene,
        revisionId: 'legacy-v1',
        assets: Object.fromEntries(plan.files.map(({ name, asset }) => [name, asset])),
      });
  }
  for (const revision of ['r1', 'r2']) {
    const prefix = `organizations/alpha/scenes/drill-rig/revisions/${revision}/`;
    const assets = {} as SceneDescriptor['assets'];
    for (const [key, filename, format] of [
      ['splats', 'splats.spz', 'spz'],
      ['colliders', 'colliders.glb', 'glb'],
    ] as const) {
      const bytes = await readFile(
        new URL(`../../public/scenes/drill-rig/${filename}`, import.meta.url),
      );
      await bucket.file(prefix + filename).save(bytes, {
        resumable: false,
        metadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
      });
      Object.assign(assets, {
        [key]: {
          path: prefix + filename,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          format,
        },
      });
    }
    descriptors.set(revision, {
      schemaVersion: 1,
      kind: 'environment-v1',
      sceneId: 'drill-rig',
      revisionId: revision,
      scope: { kind: 'organization', organizationId: 'alpha' },
      assets,
      spawn: { position: [0, 0, 0], yaw: 0, pitch: 0 },
    });
  }
}
export async function reset() {
  const response = await fetch(
    `http://127.0.0.1:8280/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error('Could not reset local portal fixtures.');
  await service.bootstrap({ orgId: 'alpha', name: 'Alpha Training', adminUid: 'admin' });
  await service.bootstrap({ orgId: 'beta', name: 'Beta Training', adminUid: 'admin' });
  const batch = db.batch();
  for (const orgId of ['alpha', 'beta'])
    batch.set(db.doc(`organizations/${orgId}/members/viewer`), {
      uid: 'viewer',
      email: 'viewer@example.test',
      role: 'viewer',
      status: 'active',
    });
  batch.set(db.doc('organizations/alpha/scenes/drill-rig'), {
    title: 'Drill Rig',
    status: 'published',
    accessMode: 'assigned',
    assignedUserIds: ['viewer'],
    publishedRevisionId: 'r1',
    version: 1,
  });
  for (const [revision, descriptor] of descriptors)
    batch.set(db.doc(`organizations/alpha/scenes/drill-rig/revisions/${revision}`), {
      status: 'ready',
      descriptor,
    });
  batch.set(db.doc('publicSettings/delivery'), { downloadsEnabled: true });
  for (const [scene, descriptor] of publicDescriptors)
    batch.set(db.doc(`publicScenes/${scene}`), {
      version: 1,
      status: 'published',
      title: scene,
      publishedRevisionId: 'legacy-v1',
      descriptor,
    });
  await batch.commit();
}
export async function invitation(email = 'outsider@example.test') {
  return service.createInvitation({
    data: { orgId: 'alpha', email, role: 'viewer' },
    auth: { uid: 'admin', token: { email: 'admin@example.test', email_verified: true } },
  } as CallableRequest);
}
export async function seed() {
  await prepare();
  await reset();
  console.log(
    'Local portal seeded. Viewer: viewer@example.test; admin: admin@example.test; password: ' +
      password,
  );
}

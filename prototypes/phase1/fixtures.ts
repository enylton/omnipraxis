import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';

import type { SceneAsset, SceneDescriptor } from '../../src/contracts/scene.ts';

export const projectId = 'demo-omnipraxis-phase1';
export const bucket = `${projectId}.appspot.com`;
export const prototypeDirectory = resolve('prototypes/phase1');
export const storageOrigin = 'http://127.0.0.1:9299';

export const createTestEnvironment = async () =>
  initializeTestEnvironment({
    projectId,
    firestore: {
      host: '127.0.0.1',
      port: 8180,
      rules: await readFile(resolve(prototypeDirectory, 'firestore.rules'), 'utf8'),
    },
    storage: {
      host: '127.0.0.1',
      port: 9299,
      rules: await readFile(resolve(prototypeDirectory, 'storage.rules'), 'utf8'),
    },
  });

export const seedFixtures = async (
  environment: Awaited<ReturnType<typeof createTestEnvironment>>,
) => {
  if (environment.projectId !== projectId) throw new Error('Refusing to seed a non-demo project.');
  await environment.clearFirestore();
  await environment.clearStorage();
  const descriptors: Record<string, SceneDescriptor> = {};
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const storage = context.storage(`gs://${bucket}`);
    for (const [uid, org, role, status] of [
      ['assigned', 'phase1', 'viewer', 'active'],
      ['unassigned', 'phase1', 'viewer', 'active'],
      ['suspended', 'phase1', 'viewer', 'suspended'],
      ['admin', 'phase1', 'admin', 'active'],
      ['outsider', 'other', 'admin', 'active'],
    ]) {
      await setDoc(doc(db, `organizations/${org}/members/${uid}`), { role, status });
    }

    for (const [sceneId, publicScene] of [
      ['drill-rig', false],
      ['base', false],
      ['circuit-breaker', true],
    ] as const) {
      const prefix = publicScene
        ? `public-scenes/${sceneId}/revisions/r1/`
        : `organizations/phase1/scenes/${sceneId}/revisions/r1/`;
      const files = await readdir(resolve('public/scenes', sceneId));
      const assets: Record<string, SceneAsset> = {};
      // Sequential uploads bound fixture memory. These are local emulators only.
      for (const filename of files) {
        const bytes = await readFile(resolve('public/scenes', sceneId, filename));
        if (bytes.subarray(0, 7).toString() === 'version') {
          throw new Error(`Fixture ${filename} is an LFS pointer; fetch LFS assets first.`);
        }
        await uploadBytes(ref(storage, `${prefix}${filename}`), bytes, {
          contentType: 'application/octet-stream',
          cacheControl: 'no-store',
        });
        assets[filename] = {
          path: `${prefix}${filename}`,
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      const descriptor: SceneDescriptor = {
        schemaVersion: 1,
        kind: 'environment-v1',
        sceneId,
        revisionId: 'r1',
        scope: publicScene
          ? { kind: 'public' }
          : { kind: 'organization', organizationId: 'phase1' },
        assets: {
          splats: {
            ...assets[publicScene ? 'splats-lod.rad' : 'splats.spz'],
            format: publicScene ? 'rad' : 'spz',
          },
          colliders: { ...assets['colliders.glb'], format: 'glb' },
        },
        spawn: { position: [0, 0, 0], yaw: 0, pitch: 0 },
      };
      descriptors[sceneId] = descriptor;
      if (publicScene) {
        await setDoc(doc(db, `publicScenes/${sceneId}`), {
          status: 'published',
          publishedRevisionId: 'r1',
          descriptor,
        });
      } else {
        const path = `organizations/phase1/scenes/${sceneId}`;
        await setDoc(doc(db, path), {
          status: 'published',
          accessMode: 'assigned',
          assignedUserIds: ['assigned'],
          publishedRevisionId: 'r1',
        });
        await setDoc(doc(db, `${path}/revisions/r1`), descriptor);
      }
    }
    await setDoc(doc(db, 'organizations/phase1/uploads/upload1'), {
      actor: 'admin',
      status: 'uploading',
      expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      slots: { 'splats.spz': 1024 },
    });
  });
  return descriptors;
};

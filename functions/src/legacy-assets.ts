import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { Timestamp } from 'firebase-admin/firestore';

import type { Firestore } from 'firebase-admin/firestore';
import type { getStorage } from 'firebase-admin/storage';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
const definitions = {
  base: { title: 'Base', props: [] },
  'circuit-breaker': {
    title: 'Circuit Breaker',
    props: ['box.glb', 'electric-box.glb', 'circuit-breaker.glb', 'circuit-breaker-set.glb'],
  },
  'pressure-gauge': {
    title: 'Pressure Gauge',
    props: [
      'box.glb',
      'duto_sem_valvulas.glb',
      'volante_esquerdo.glb',
      'volante_direito.glb',
      'manometro.glb',
      'venteio.glb',
    ],
  },
  'drill-rig': { title: 'Drill Rig', props: [] },
} as const;
export type LegacyScene = keyof typeof definitions;
type Asset = { path: string; bytes: number; sha256: string };
type Plan = {
  scene: LegacyScene;
  revision: string;
  org: string;
  prefix: string;
  bytes: number;
  fingerprint: string;
  files: { name: string; local: string; asset: Asset }[];
};
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const identifier = (value: string) => /^[A-Za-z0-9_-]{1,100}$/.test(value);

export async function planLegacyImport(
  root: string,
  scene: LegacyScene,
  revision: string,
  org: string,
): Promise<Plan> {
  if (!Object.hasOwn(definitions, scene) || !identifier(revision) || !identifier(org))
    throw new Error('Invalid legacy import identity.');
  const source = await realpath(root);
  const directory = resolve(source, 'scenes', scene);
  const names = (await readdir(directory)).sort();
  const splat = scene === 'base' || scene === 'drill-rig' ? 'splats.spz' : 'splats-lod.rad';
  if (
    !names.includes(splat) ||
    !names.includes('colliders.glb') ||
    names.some(
      (name) =>
        name !== splat &&
        name !== 'colliders.glb' &&
        (!splat.endsWith('.rad') || !/^[A-Za-z0-9_-]+\.radc$/.test(name)),
    )
  )
    throw new Error('Unexpected legacy source files.');
  const prefix =
    scene === 'drill-rig'
      ? `organizations/${org}/scenes/drill-rig/revisions/${revision}/`
      : `public-scenes/${scene}/revisions/${revision}/`;
  const files: Plan['files'] = [];
  let bytes = 0;
  const inputs = [
    ...names.map((name) => ({ name, local: resolve(directory, name) })),
    ...definitions[scene].props.map((name) => ({
      name: `props/${name}`,
      local: resolve(source, 'assets', name),
    })),
  ];
  for (const input of inputs) {
    const local = await realpath(input.local);
    const info = await stat(local);
    if (
      !local.startsWith(source + sep) ||
      !info.isFile() ||
      info.size < 1 ||
      info.size > 100 * 1024 * 1024
    )
      throw new Error('Unsafe or oversized legacy source.');
    const buffer = await readFile(local);
    if (buffer.subarray(0, 40).toString().startsWith('version https://git-lfs.github.com/'))
      throw new Error('Fetch Git LFS assets before importing.');
    files.push({
      ...input,
      local,
      asset: { path: prefix + input.name, bytes: buffer.length, sha256: digest(buffer) },
    });
    bytes += buffer.length;
  }
  if (bytes > 500 * 1024 * 1024 || files.length > 1000)
    throw new Error('Legacy revision exceeds import limits.');
  return {
    scene,
    revision,
    org,
    prefix,
    bytes,
    files,
    fingerprint: digest(JSON.stringify(files.map(({ name, asset }) => ({ name, asset })))),
  };
}

export async function importLegacyAssets(
  db: Firestore,
  bucket: Bucket,
  plan: Plan,
  expectedVersion = 0,
) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new Error('Invalid expected scene version.');
  const { scene, revision, org } = plan;
  const receiptRef = db.doc(
    `system/legacyImport-${scene === 'drill-rig' ? org : 'public'}-${scene}-${revision}`,
  );
  const quotaRef = db.doc('system/assetQuota');
  const publicScene = scene !== 'drill-rig';
  const sceneRef = db.doc(
    publicScene ? `publicScenes/${scene}` : `organizations/${org}/scenes/${scene}`,
  );
  const revisionRef = db.doc(
    publicScene
      ? `publicSceneImports/${scene}/revisions/${revision}`
      : `${sceneRef.path}/revisions/${revision}`,
  );
  await db.runTransaction(async (tx) => {
    const [delivery, receipt, quota, organization, current, published] = await tx.getAll(
      db.doc('publicSettings/delivery'),
      receiptRef,
      quotaRef,
      db.doc(`organizations/${org}`),
      revisionRef,
      sceneRef,
    );
    if (delivery.get('downloadsEnabled') !== true) throw new Error('Asset imports are suspended.');
    if (!publicScene && !organization.exists)
      throw new Error('Bootstrap the target organization first.');
    if (receipt.exists && receipt.get('fingerprint') !== plan.fingerprint)
      throw new Error('This immutable import identity already has different assets.');
    if (current.exists && current.get('fingerprint') !== plan.fingerprint)
      throw new Error('The revision already belongs to another publication.');
    if (
      receipt.get('status') !== 'ready' &&
      (published.exists ? published.get('version') : 0) !== expectedVersion
    )
      throw new Error('Scene changed; supply its reviewed expected version before importing.');
    if (!receipt.exists) {
      const used = Number(quota.get('usedBytes') ?? 0);
      if (!Number.isSafeInteger(used) || used < 0 || used + plan.bytes > 5 * 1024 ** 3)
        throw new Error('Managed asset quota exceeded.');
      tx.set(quotaRef, { usedBytes: used + plan.bytes }, { merge: true });
      tx.create(receiptRef, {
        fingerprint: plan.fingerprint,
        bytes: plan.bytes,
        status: 'reserved',
        expectedVersion,
        createdAt: Timestamp.now(),
      });
    } else if (
      receipt.get('status') !== 'ready' &&
      receipt.get('expectedVersion') !== expectedVersion
    ) {
      throw new Error('Resume the import with its original expected version.');
    }
  });
  const assets: Record<string, Asset & { generation: string }> = {};
  for (const { name, local, asset } of plan.files) {
    if ((await db.doc('publicSettings/delivery').get()).get('downloadsEnabled') !== true)
      throw new Error('Asset imports are suspended; reservation is retained for a safe retry.');
    const bytes = await readFile(local);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
      throw new Error('Legacy source changed after planning.');
    const file = bucket.file(asset.path);
    const [exists] = await file.exists();
    if (!exists)
      await file.save(bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: name.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream',
          cacheControl: 'no-store',
          metadata: {},
        },
      });
    const [metadata] = await file.getMetadata();
    const [stored] = await file.download();
    if (
      stored.length !== asset.bytes ||
      digest(stored) !== asset.sha256 ||
      metadata.cacheControl !== 'no-store' ||
      Object.keys(metadata.metadata ?? {}).length
    )
      throw new Error('Immutable object checksum or token/cache metadata does not match.');
    assets[name] = { ...asset, generation: String(metadata.generation) };
  }
  const descriptor = publicScene
    ? {
        schemaVersion: 1,
        kind: 'public-demo-v1',
        sceneId: scene,
        revisionId: revision,
        assets,
      }
    : {
        schemaVersion: 1,
        kind: 'environment-v1',
        sceneId: scene,
        revisionId: revision,
        scope: { kind: 'organization', organizationId: org },
        assets: {
          splats: { ...assets['splats.spz'], format: 'spz' },
          colliders: { ...assets['colliders.glb'], format: 'glb' },
        },
        spawn: { position: [0, 0, 0], yaw: 0, pitch: 0 },
      };
  await db.runTransaction(async (tx) => {
    const [delivery, receipt, current, existing] = await tx.getAll(
      db.doc('publicSettings/delivery'),
      receiptRef,
      sceneRef,
      revisionRef,
    );
    if (delivery.get('downloadsEnabled') !== true) throw new Error('Asset imports are suspended.');
    if (receipt.get('fingerprint') !== plan.fingerprint)
      throw new Error('Import ownership changed.');
    if (existing.exists && existing.get('fingerprint') !== plan.fingerprint)
      throw new Error('Revision changed.');
    if (receipt.get('status') === 'ready') return; // Idempotent retries never republish over a newer scene.
    if ((current.exists ? current.get('version') : 0) !== expectedVersion)
      throw new Error('Scene changed during import; previous publication is intact.');
    tx.set(revisionRef, {
      status: 'ready',
      fingerprint: plan.fingerprint,
      descriptor,
      createdAt: Timestamp.now(),
    });
    tx.set(
      sceneRef,
      {
        title: definitions[scene].title,
        status: 'published',
        publishedRevisionId: revision,
        version: expectedVersion + 1,
        ...(publicScene
          ? { descriptor }
          : current.exists
            ? {}
            : { accessMode: 'organization', assignedUserIds: [] }),
      },
      { merge: true },
    );
    tx.update(receiptRef, { status: 'ready', completedAt: Timestamp.now() });
  });
  return { descriptor, bytes: plan.bytes, files: plan.files.length };
}

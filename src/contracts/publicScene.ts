import type { SceneAsset } from './scene';

export const publicSceneProps = {
  base: [],
  'circuit-breaker': [
    'box.glb',
    'electric-box.glb',
    'circuit-breaker.glb',
    'circuit-breaker-set.glb',
  ],
  'pressure-gauge': [
    'box.glb',
    'duto_sem_valvulas.glb',
    'volante_esquerdo.glb',
    'volante_direito.glb',
    'manometro.glb',
    'venteio.glb',
  ],
} as const;
export type PublicSceneId = keyof typeof publicSceneProps;
export type PublicSceneDescriptor = {
  schemaVersion: 1;
  kind: 'public-demo-v1';
  sceneId: PublicSceneId;
  revisionId: string;
  assets: Record<string, SceneAsset>;
};

export function parsePublicScene(input: unknown): PublicSceneDescriptor {
  const value = input as PublicSceneDescriptor;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.kind !== 'public-demo-v1' ||
    !Object.hasOwn(publicSceneProps, value.sceneId) ||
    typeof value.revisionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.revisionId) ||
    !value.assets ||
    typeof value.assets !== 'object' ||
    Array.isArray(value.assets)
  )
    throw new Error('Invalid public scene revision.');
  const prefix = `public-scenes/${value.sceneId}/revisions/${value.revisionId}/`;
  const required = [
    'colliders.glb',
    value.sceneId === 'base' ? 'splats.spz' : 'splats-lod.rad',
    ...publicSceneProps[value.sceneId].map((name) => `props/${name}`),
  ];
  const entries = Object.entries(value.assets);
  if (entries.length > 1000 || required.some((name) => !Object.hasOwn(value.assets, name)))
    throw new Error('Incomplete public scene assets.');
  let total = 0;
  for (const [name, asset] of entries) {
    if (
      (!required.includes(name) &&
        (value.sceneId === 'base' || !/^[A-Za-z0-9_-]+\.radc$/.test(name))) ||
      !asset ||
      asset.path !== prefix + name ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > 100 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw new Error('Invalid public asset reference.');
    total += asset.bytes;
  }
  if (total > 500 * 1024 * 1024) throw new Error('Public scene exceeds import bounds.');
  return structuredClone(value);
}

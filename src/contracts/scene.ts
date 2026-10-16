export type SceneVector = readonly [number, number, number];

export type SceneAsset = {
  path: string;
  bytes: number;
  sha256: string;
};

export type SceneDescriptor = {
  schemaVersion: 1;
  kind: 'environment-v1';
  sceneId: string;
  revisionId: string;
  scope: { kind: 'public' } | { kind: 'organization'; organizationId: string };
  assets: {
    splats: SceneAsset & { format: 'spz' | 'rad' };
    colliders: SceneAsset & { format: 'glb' };
  };
  spawn: { position: SceneVector; yaw: number; pitch: number };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const sceneRevisionPrefix = (descriptor: SceneDescriptor): string =>
  descriptor.scope.kind === 'public'
    ? `public-scenes/${descriptor.sceneId}/revisions/${descriptor.revisionId}/`
    : `organizations/${descriptor.scope.organizationId}/scenes/${descriptor.sceneId}/revisions/${descriptor.revisionId}/`;

export const parseSceneDescriptor = (value: unknown): SceneDescriptor => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'environment-v1' ||
    !isIdentifier(value.sceneId) ||
    !isIdentifier(value.revisionId) ||
    !isRecord(value.scope) ||
    !(
      value.scope.kind === 'public' ||
      (value.scope.kind === 'organization' && isIdentifier(value.scope.organizationId))
    ) ||
    !isRecord(value.assets) ||
    !isRecord(value.spawn) ||
    !Array.isArray(value.spawn.position) ||
    value.spawn.position.length !== 3 ||
    !value.spawn.position.every(isFiniteNumber) ||
    !isFiniteNumber(value.spawn.yaw) ||
    !isFiniteNumber(value.spawn.pitch)
  ) {
    throw new Error('Unsupported or invalid scene descriptor.');
  }

  const descriptor = value as SceneDescriptor;
  const prefix = sceneRevisionPrefix(descriptor);

  for (const [key, formats] of [
    ['splats', ['spz', 'rad']],
    ['colliders', ['glb']],
  ] as const) {
    const asset = value.assets[key];
    if (
      !isRecord(asset) ||
      typeof asset.path !== 'string' ||
      !asset.path.startsWith(prefix) ||
      !/^[a-zA-Z0-9_./-]+$/.test(asset.path) ||
      asset.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(asset.bytes) ||
      (asset.bytes as number) <= 0 ||
      (asset.bytes as number) > 100 * 1024 * 1024 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !(formats as readonly unknown[]).includes(asset.format) ||
      !asset.path.endsWith(`.${asset.format}`)
    ) {
      throw new Error(`Invalid or out-of-revision ${key} asset.`);
    }
  }

  if (descriptor.scope.kind === 'organization' && descriptor.assets.splats.format === 'rad') {
    throw new Error('Restricted paged scenes are outside the Phase 1 contract.');
  }

  // Capture validated JSON so callers cannot change paths while downloads are in flight.
  return structuredClone(descriptor);
};

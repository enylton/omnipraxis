export type ViewerScene = {
  template: 'environment';
  sessionId: string;
  assets: {
    splatsUrl: string;
    splatsFormat: 'spz' | 'rad';
    collidersUrl: string;
    resolvePageUrl?: (filename: string) => string;
  };
  spawn: { position: readonly [number, number, number]; yaw: number; pitch: number };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const parseViewerScene = (value: unknown): ViewerScene => {
  if (
    !isRecord(value) ||
    value.template !== 'environment' ||
    !isNonemptyString(value.sessionId) ||
    !isRecord(value.assets) ||
    !isNonemptyString(value.assets.splatsUrl) ||
    !['spz', 'rad'].includes(value.assets.splatsFormat as string) ||
    !isNonemptyString(value.assets.collidersUrl) ||
    !(
      value.assets.resolvePageUrl === undefined || typeof value.assets.resolvePageUrl === 'function'
    ) ||
    !isRecord(value.spawn) ||
    !Array.isArray(value.spawn.position) ||
    value.spawn.position.length !== 3 ||
    !Array.from(value.spawn.position).every(isFiniteNumber) ||
    !isFiniteNumber(value.spawn.yaw) ||
    !isFiniteNumber(value.spawn.pitch)
  ) {
    throw new Error('Unsupported or invalid viewer scene.');
  }

  const scene = value as ViewerScene;
  // Capture render inputs without copying callbacks or retaining caller-owned objects.
  return {
    template: 'environment',
    sessionId: scene.sessionId,
    assets: {
      splatsUrl: scene.assets.splatsUrl,
      splatsFormat: scene.assets.splatsFormat,
      collidersUrl: scene.assets.collidersUrl,
      resolvePageUrl: scene.assets.resolvePageUrl,
    },
    spawn: {
      position: [...scene.spawn.position],
      yaw: scene.spawn.yaw,
      pitch: scene.spawn.pitch,
    },
  };
};

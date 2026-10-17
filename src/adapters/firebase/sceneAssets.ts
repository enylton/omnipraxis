import { parseSceneDescriptor, sceneRevisionPrefix } from '../../contracts/scene.ts';

import type { AssetTransport } from './assetTransport';
import type { SceneAsset } from '../../contracts/scene';
import type { ViewerScene } from '../../viewer/api';

export type ResolvedSceneAssets = {
  scene: ViewerScene;
  dispose: () => void;
};

export const verifyAsset = async (blob: Blob, asset: SceneAsset): Promise<Blob> => {
  if (blob.size !== asset.bytes) throw new Error('Scene asset length does not match its revision.');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== asset.sha256) throw new Error('Scene asset checksum does not match its revision.');
  return blob;
};

export const resolveStorageAssets = async (
  transport: AssetTransport,
  input: unknown,
  signal: AbortSignal,
): Promise<ResolvedSceneAssets> => {
  const descriptor = parseSceneDescriptor(input);
  signal.throwIfAborted();

  const download = async (asset: SceneAsset) => {
    const blob = await transport.read(asset.path, asset.bytes, signal);
    signal.throwIfAborted();
    return verifyAsset(blob, asset);
  };

  const [splats, colliders] = await Promise.all([
    descriptor.assets.splats.format === 'spz' ? download(descriptor.assets.splats) : null,
    download(descriptor.assets.colliders),
  ]);
  signal.throwIfAborted();

  const headerLease =
    descriptor.assets.splats.format === 'rad' ? await transport.liveHeaders() : undefined;
  const urls = [URL.createObjectURL(colliders)];
  const collidersUrl = urls[0];
  const splatsUrl = splats
    ? URL.createObjectURL(splats)
    : transport.page(descriptor.assets.splats.path);
  if (splats) urls.push(splatsUrl);
  const prefix = sceneRevisionPrefix(descriptor);
  let disposed = false;

  return {
    scene: {
      template: 'environment',
      sessionId: `${descriptor.sceneId}:${descriptor.revisionId}`,
      assets: {
        splatsUrl,
        splatsFormat: descriptor.assets.splats.format,
        collidersUrl,
        resolvePageUrl:
          descriptor.assets.splats.format === 'rad'
            ? (filename) => {
                // RAD headers are untrusted input. Only allow files in this revision's directory.
                if (!/^[a-zA-Z0-9_-]+\.radc$/.test(filename)) {
                  throw new Error('Invalid RAD page filename.');
                }
                return transport.page(`${prefix}${filename}`);
              }
            : undefined,
        requestHeader: headerLease?.value,
      },
      spawn: descriptor.spawn,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      headerLease?.dispose();
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
};

import { getBlob, ref } from 'firebase/storage';

import { parseSceneDescriptor, sceneRevisionPrefix } from '../../contracts/scene.ts';

import type { SceneAsset } from '../../contracts/scene';
import type { ViewerScene } from '../../viewer/api';
import type { FirebaseStorage } from 'firebase/storage';

export type ResolvedSceneAssets = {
  scene: ViewerScene;
  dispose: () => void;
};

export const storageMediaUrl = (storage: FirebaseStorage, path: string, origin?: string): string =>
  `${origin ?? 'https://firebasestorage.googleapis.com'}/v0/b/${encodeURIComponent(ref(storage).bucket)}/o/${encodeURIComponent(path)}?alt=media`;

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
  storage: FirebaseStorage,
  input: unknown,
  signal: AbortSignal,
  origin?: string,
): Promise<ResolvedSceneAssets> => {
  const descriptor = parseSceneDescriptor(input);
  signal.throwIfAborted();

  const download = async (asset: SceneAsset) => {
    const blob = await getBlob(ref(storage, asset.path), asset.bytes);
    signal.throwIfAborted();
    return verifyAsset(blob, asset);
  };

  const [splats, colliders] = await Promise.all([
    descriptor.assets.splats.format === 'spz' ? download(descriptor.assets.splats) : null,
    download(descriptor.assets.colliders),
  ]);
  signal.throwIfAborted();

  const urls = [URL.createObjectURL(colliders)];
  const collidersUrl = urls[0];
  const splatsUrl = splats
    ? URL.createObjectURL(splats)
    : storageMediaUrl(storage, descriptor.assets.splats.path, origin);
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
                return storageMediaUrl(storage, `${prefix}${filename}`, origin);
              }
            : undefined,
      },
      spawn: descriptor.spawn,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
};

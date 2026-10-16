import { getBlob, ref } from 'firebase/storage';

import { storageMediaUrl, verifyAsset } from './sceneAssets';
import { parsePublicScene } from '../../contracts/publicScene';

import type { PublicDemoAssets } from '../../viewer/public-api';
import type { FirebaseStorage } from 'firebase/storage';

export async function resolvePublicAssets(
  storage: FirebaseStorage,
  input: unknown,
  signal: AbortSignal,
  origin?: string,
) {
  const descriptor = parsePublicScene(input);
  const urls: string[] = [];
  const resolved: Record<string, string> = {};
  const dispose = () => {
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  };
  try {
    // Sequential acquisition bounds transient decoded/binary memory and cleans up on failure.
    for (const [name, asset] of Object.entries(descriptor.assets)) {
      if (name.endsWith('.radc')) continue;
      signal.throwIfAborted();
      const blob = await getBlob(ref(storage, asset.path), asset.bytes);
      signal.throwIfAborted();
      await verifyAsset(blob, asset);
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      urls.push(url);
      resolved[name] = url;
    }
    const assets: PublicDemoAssets = {
      splatsUrl: resolved[descriptor.sceneId === 'base' ? 'splats.spz' : 'splats-lod.rad'],
      collidersUrl: resolved['colliders.glb'],
      props: Object.fromEntries(
        Object.entries(resolved)
          .filter(([name]) => name.startsWith('props/'))
          .map(([name, url]) => [name.slice(6), url]),
      ),
      resolvePageUrl:
        descriptor.sceneId === 'base'
          ? undefined
          : (filename) => {
              if (
                !/^[A-Za-z0-9_-]+\.radc$/.test(filename) ||
                !Object.hasOwn(descriptor.assets, filename)
              )
                throw new Error('RAD page is outside the imported revision.');
              return storageMediaUrl(storage, descriptor.assets[filename].path, origin);
            },
    };
    return { assets, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

import { createRoot } from 'react-dom/client';

import { ViewerRuntime } from './ViewerRuntime';
import { parseSceneDescriptor } from '../contracts/scene';
import { releaseGltfAsset } from '../runtime/assets/releaseGltfAsset';

import type { SceneDescriptor } from '../contracts/scene';
import type { ResolvedSceneAssets } from './assets/storageAssets';
import type { SessionSnapshot } from '../runtime/events/EventLogSession';
import type { Group } from 'three';

export type { SceneDescriptor, SceneAsset } from '../contracts/scene';
export type { ResolvedSceneAssets } from './assets/storageAssets';

type ViewerOptions = {
  descriptor: SceneDescriptor;
  assets: ResolvedSceneAssets;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onSessionComplete?: (snapshot: SessionSnapshot) => void;
};

export const mountViewer = (host: HTMLElement, options: ViewerOptions): { dispose: () => void } => {
  if (host.hasChildNodes()) throw new Error('Viewer host must be empty.');
  const descriptor = parseSceneDescriptor(options.descriptor);
  const root = createRoot(host);
  let model: Group | undefined;
  let disposed = false;
  let ready = false;
  const onReady = () => {
    if (disposed || ready) return;
    ready = true;
    options.onReady?.();
  };
  const onModelLoaded = (scene: Group) => {
    model = scene;
  };

  root.render(
    <ViewerRuntime
      descriptor={descriptor}
      assets={options.assets}
      onReady={onReady}
      onModelLoaded={onModelLoaded}
      onError={(error) => !disposed && options.onError?.(error)}
      onSessionComplete={options.onSessionComplete}
    />,
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (host.contains(document.pointerLockElement)) document.exitPointerLock();
      root.unmount();
      if (model) releaseGltfAsset(options.assets.collidersUrl, model);
      options.assets.dispose();
    },
  };
};

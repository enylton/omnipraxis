import { createRoot } from 'react-dom/client';

import { parseViewerScene } from './scene';
import { ViewerRuntime } from './ViewerRuntime';
import { releaseGltfAsset } from '../runtime/assets/releaseGltfAsset';

import type { ViewerScene } from './scene';
import type { SessionSnapshot } from '../runtime/events/EventLogSession';
import type { Group } from 'three';

export type { ViewerScene } from './scene';

type ViewerOptions = {
  scene: ViewerScene;
  releaseAssets?: () => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onSessionComplete?: (snapshot: SessionSnapshot) => void;
};

export const mountViewer = (host: HTMLElement, options: ViewerOptions): { dispose: () => void } => {
  if (host.hasChildNodes()) throw new Error('Viewer host must be empty.');
  const scene = parseViewerScene(options.scene);
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
      scene={scene}
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
      if (model) releaseGltfAsset(scene.assets.collidersUrl, model);
      options.releaseAssets?.();
    },
  };
};

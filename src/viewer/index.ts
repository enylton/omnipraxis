import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { parseViewerScene } from './scene';
import { toViewerSessionSnapshot } from './session';
import { VIEWER_API_VERSION } from './version';
import { ViewerRuntime } from './ViewerRuntime';
import { releaseGltfAsset } from '../runtime/assets/releaseGltfAsset';
import './viewer.css';

import type { MountViewer } from './api';
import type { Group } from 'three';

export { VIEWER_API_VERSION } from './version';
export type {
  MountViewer,
  ViewerEvent,
  ViewerHandle,
  ViewerJsonValue,
  ViewerOptions,
  ViewerScene,
  ViewerSessionSnapshot,
} from './api';

export const mountViewer: MountViewer = (host, options) => {
  if (options.apiVersion !== VIEWER_API_VERSION) throw new Error('Unsupported viewer API version.');
  if (host.hasChildNodes()) throw new Error('Viewer host must be empty.');
  const scene = parseViewerScene(options.scene);
  const hadViewerClass = host.classList.contains('omnipraxis-viewer');
  host.classList.add('omnipraxis-viewer');
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
    createElement(ViewerRuntime, {
      scene,
      onReady,
      onModelLoaded,
      onError: (error) => !disposed && options.onError?.(error),
      onSessionComplete: (snapshot) => {
        if (!disposed) options.onSessionComplete?.(toViewerSessionSnapshot(snapshot));
      },
    }),
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (host.contains(document.pointerLockElement)) document.exitPointerLock();
      root.unmount();
      if (!hadViewerClass) host.classList.remove('omnipraxis-viewer');
      if (model) releaseGltfAsset(scene.assets.collidersUrl, model);
      options.releaseAssets?.();
    },
  };
};

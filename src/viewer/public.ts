import { useGLTF } from '@react-three/drei';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { PublicDemoRuntime } from './PublicDemoRuntime';
import { toViewerSessionSnapshot } from './session';
import { releaseGltfAsset } from '../runtime/assets/releaseGltfAsset';
import './viewer.css';

import type { MountPublicDemo } from './public-api';
import type { Group } from 'three';

export const mountPublicDemo: MountPublicDemo = (host, options) => {
  const requiredProps =
    options.scene === 'circuit-breaker'
      ? ['box.glb', 'electric-box.glb', 'circuit-breaker.glb', 'circuit-breaker-set.glb']
      : options.scene === 'pressure-gauge'
        ? [
            'box.glb',
            'duto_sem_valvulas.glb',
            'volante_esquerdo.glb',
            'volante_direito.glb',
            'manometro.glb',
            'venteio.glb',
          ]
        : [];
  if (
    options.apiVersion !== 2 ||
    !['base', 'circuit-breaker', 'pressure-gauge'].includes(options.scene) ||
    !options.assets?.splatsUrl ||
    !options.assets.collidersUrl ||
    !options.assets.props ||
    requiredProps.some((name) => !options.assets.props[name]) ||
    (options.scene !== 'base' && typeof options.assets.resolvePageUrl !== 'function')
  )
    throw new Error('Unsupported public demonstration.');
  if (host.hasChildNodes()) throw new Error('Viewer host must be empty.');
  const hadClass = host.classList.contains('omnipraxis-viewer');
  host.classList.add('omnipraxis-viewer');
  const root = createRoot(host);
  const models = new Map<string, Group>();
  let disposed = false;
  let ready = false;
  root.render(
    createElement(PublicDemoRuntime, {
      scene: options.scene,
      assets: options.assets,
      onReady: () => {
        if (disposed || ready) return;
        ready = true;
        options.onReady?.();
      },
      onModelLoaded: (url: string, model: Group) => models.set(url, model),
      onSessionComplete: (snapshot) => {
        if (!disposed) options.onSessionComplete?.(toViewerSessionSnapshot(snapshot));
      },
      onError: (error: Error) => {
        if (!disposed) options.onError?.(error);
      },
    }),
  );
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (host.contains(document.pointerLockElement)) document.exitPointerLock();
      root.unmount();
      for (const [url, model] of models) releaseGltfAsset(url, model);
      // A canceled Suspense load may not have reached its registration effect.
      for (const url of [options.assets.collidersUrl, ...Object.values(options.assets.props)])
        if (!models.has(url)) useGLTF.clear(url);
      models.clear();
      options.releaseAssets?.();
      if (!hadClass) host.classList.remove('omnipraxis-viewer');
    },
  };
};

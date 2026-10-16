import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { PublicDemoRuntime } from './PublicDemoRuntime';
import './viewer.css';

import type { MountPublicDemo } from './public-api';

export const mountPublicDemo: MountPublicDemo = (host, options) => {
  if (
    options.apiVersion !== 1 ||
    !['base', 'circuit-breaker', 'pressure-gauge'].includes(options.scene)
  )
    throw new Error('Unsupported public demonstration.');
  if (host.hasChildNodes()) throw new Error('Viewer host must be empty.');
  const hadClass = host.classList.contains('omnipraxis-viewer');
  host.classList.add('omnipraxis-viewer');
  const root = createRoot(host);
  let disposed = false;
  root.render(
    createElement(PublicDemoRuntime, {
      scene: options.scene,
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
      if (!hadClass) host.classList.remove('omnipraxis-viewer');
    },
  };
};

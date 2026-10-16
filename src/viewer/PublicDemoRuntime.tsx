import { useGLTF } from '@react-three/drei';
import { Component, useLayoutEffect } from 'react';

import { RendererLifetime } from './compat/RendererLifetime';
import { ConvaiRuntime } from '../runtime/convai/ConvaiRuntime';
import { RuntimeApp } from '../RuntimeApp';
import { BaseScene } from '../scenes/base/scene';
import { CircuitBreakerScene } from '../scenes/circuit-breaker/scene';
import { PressureGaugeScene } from '../scenes/pressure-gauge/scene';

import type { PublicDemo, PublicDemoAssets } from './public-api';
import type { SessionSnapshot } from '../runtime/events/EventLogSession';
import type { ReactNode } from 'react';
import type { Group } from 'three';

class Boundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
// Load the allowed GLBs before mounting their physical/interactive clones, and
// retain their cache sources so disposal can release each session-owned URL once.
function PreparedModels({
  assets,
  onModelLoaded,
  children,
}: {
  assets: PublicDemoAssets;
  onModelLoaded: (url: string, model: Group) => void;
  children: ReactNode;
}) {
  const urls = [assets.collidersUrl, ...Object.values(assets.props)];
  const models = useGLTF(urls);
  useLayoutEffect(() => {
    models.forEach((model, index) => onModelLoaded(urls[index], model.scene));
  });
  return children;
}

export const PublicDemoRuntime = ({
  scene,
  assets,
  onReady,
  onModelLoaded,
  onSessionComplete,
  onError,
}: {
  scene: PublicDemo;
  assets: PublicDemoAssets;
  onReady: () => void;
  onModelLoaded: (url: string, model: Group) => void;
  onSessionComplete: (snapshot: SessionSnapshot) => void;
  onError: (error: Error) => void;
}) => (
  <Boundary onError={onError}>
    <RuntimeApp
      sceneId={scene}
      onSessionComplete={onSessionComplete}
      canvasRuntimes={
        <>
          <RendererLifetime />
          <ConvaiRuntime />
        </>
      }
    >
      <PreparedModels assets={assets} onModelLoaded={onModelLoaded}>
        {scene === 'base' ? (
          <BaseScene
            splatsUrl={assets.splatsUrl}
            collidersUrl={assets.collidersUrl}
            onReady={onReady}
          />
        ) : scene === 'circuit-breaker' ? (
          <CircuitBreakerScene
            splatsUrl={assets.splatsUrl}
            collidersUrl={assets.collidersUrl}
            electricBoxUrl={assets.props['electric-box.glb']}
            circuitBreakerUrl={assets.props['circuit-breaker.glb']}
            circuitBreakerSetUrl={assets.props['circuit-breaker-set.glb']}
            boxUrl={assets.props['box.glb']}
            resolvePageUrl={assets.resolvePageUrl}
            onReady={onReady}
          />
        ) : (
          <PressureGaugeScene
            splatsUrl={assets.splatsUrl}
            collidersUrl={assets.collidersUrl}
            ductUrl={assets.props['duto_sem_valvulas.glb']}
            leftValveUrl={assets.props['volante_esquerdo.glb']}
            rightValveUrl={assets.props['volante_direito.glb']}
            gaugeUrl={assets.props['manometro.glb']}
            ventUrl={assets.props['venteio.glb']}
            boxUrl={assets.props['box.glb']}
            resolvePageUrl={assets.resolvePageUrl}
            onReady={onReady}
          />
        )}
      </PreparedModels>
    </RuntimeApp>
  </Boundary>
);

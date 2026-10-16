import { Component, createElement } from 'react';

import { RendererLifetime } from './compat/RendererLifetime';
import { ConvaiRuntime } from '../runtime/convai/ConvaiRuntime';
import { downloadSessionLog } from '../runtime/events/downloadSessionLog';
import { RuntimeApp } from '../RuntimeApp';
import { BaseScene } from '../scenes/base/scene';
import { CircuitBreakerScene } from '../scenes/circuit-breaker/scene';
import { PressureGaugeScene } from '../scenes/pressure-gauge/scene';

import type { PublicDemo } from './public-api';
import type { ReactNode } from 'react';

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
const scenes = {
  base: BaseScene,
  'circuit-breaker': CircuitBreakerScene,
  'pressure-gauge': PressureGaugeScene,
};

export const PublicDemoRuntime = ({
  scene,
  onError,
}: {
  scene: PublicDemo;
  onError: (error: Error) => void;
}) => (
  <Boundary onError={onError}>
    <RuntimeApp
      sceneId={scene}
      onSessionComplete={downloadSessionLog}
      canvasRuntimes={
        <>
          <RendererLifetime />
          <ConvaiRuntime />
        </>
      }
    >
      {createElement(scenes[scene])}
    </RuntimeApp>
  </Boundary>
);

import { useThree } from '@react-three/fiber';
import { Component, useEffect } from 'react';

import { EnvironmentScene } from './EnvironmentScene';
import { RuntimeApp } from '../RuntimeApp';

import type { EnvironmentSceneProps } from './EnvironmentScene';
import type { SessionSnapshot } from '../runtime/events/EventLogSession';
import type { ErrorInfo, ReactNode } from 'react';

const RendererLifetime = () => {
  const renderer = useThree((state) => state.gl);
  useEffect(
    () => () => {
      // R3F performs context/scene teardown after 500 ms. Keep renderer caches
      // available for pending Spark work until that step has finished.
      setTimeout(() => renderer.dispose(), 600);
    },
    [renderer],
  );
  return null;
};

class ViewerErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type ViewerRuntimeProps = EnvironmentSceneProps & {
  onError: (error: Error) => void;
  onSessionComplete?: (snapshot: SessionSnapshot) => void;
};

export const ViewerRuntime = ({ onError, onSessionComplete, ...scene }: ViewerRuntimeProps) => (
  <ViewerErrorBoundary onError={onError}>
    <RuntimeApp
      sceneId={`${scene.descriptor.sceneId}:${scene.descriptor.revisionId}`}
      onSessionComplete={onSessionComplete}
      canvasRuntimes={<RendererLifetime />}
    >
      <EnvironmentScene {...scene} />
    </RuntimeApp>
  </ViewerErrorBoundary>
);

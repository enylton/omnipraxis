import { Component } from 'react';

import { RendererLifetime } from './compat/RendererLifetime';
import { EnvironmentScene } from './EnvironmentScene';
import { RuntimeApp } from '../RuntimeApp';

import type { EnvironmentSceneProps } from './EnvironmentScene';
import type { SessionSnapshot } from '../runtime/events/EventLogSession';
import type { ErrorInfo, ReactNode } from 'react';

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

export const ViewerRuntime = ({ onError, onSessionComplete, ...props }: ViewerRuntimeProps) => (
  <ViewerErrorBoundary onError={onError}>
    <RuntimeApp
      sceneId={props.scene.sessionId}
      onSessionComplete={onSessionComplete}
      canvasRuntimes={<RendererLifetime />}
    >
      <EnvironmentScene {...props} />
    </RuntimeApp>
  </ViewerErrorBoundary>
);

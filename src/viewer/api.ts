import type { VIEWER_API_VERSION } from './version';

export { VIEWER_API_VERSION } from './version';

export type ViewerScene = {
  template: 'environment';
  sessionId: string;
  assets: {
    splatsUrl: string;
    splatsFormat: 'spz' | 'rad';
    collidersUrl: string;
    resolvePageUrl?: (filename: string) => string;
    requestHeader?: Record<string, string>;
  };
  spawn: { position: readonly [number, number, number]; yaw: number; pitch: number };
};

export type ViewerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ViewerJsonValue[]
  | { readonly [key: string]: ViewerJsonValue };

export type ViewerEvent = Readonly<{
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  type: string;
  source?: string;
  data: ViewerJsonValue;
}>;

export type ViewerSessionSnapshot = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  scene: string;
  status: 'pending' | 'active' | 'completed';
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  events: readonly ViewerEvent[];
}>;

export type ViewerOptions = {
  apiVersion: typeof VIEWER_API_VERSION;
  scene: ViewerScene;
  releaseAssets?: () => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onSessionComplete?: (snapshot: ViewerSessionSnapshot) => void;
};

export type ViewerHandle = { dispose: () => void };
export type MountViewer = (host: HTMLElement, options: ViewerOptions) => ViewerHandle;

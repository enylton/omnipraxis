import type { ViewerSessionSnapshot } from './api';

export type PublicDemo = 'base' | 'circuit-breaker' | 'pressure-gauge';
export type PublicDemoAssets = {
  splatsUrl: string;
  collidersUrl: string;
  props: Readonly<Record<string, string>>;
  resolvePageUrl?: (filename: string) => string;
};
export type PublicDemoOptions = {
  apiVersion: 2;
  scene: PublicDemo;
  assets: PublicDemoAssets;
  releaseAssets?: () => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onSessionComplete?: (snapshot: ViewerSessionSnapshot) => void;
};
export type PublicDemoHandle = { dispose: () => void };
export type MountPublicDemo = (host: HTMLElement, options: PublicDemoOptions) => PublicDemoHandle;

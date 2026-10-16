export type PublicDemo = 'base' | 'circuit-breaker' | 'pressure-gauge';
export type PublicDemoOptions = {
  apiVersion: 1;
  scene: PublicDemo;
  onError?: (error: Error) => void;
};
export type PublicDemoHandle = { dispose: () => void };
export type MountPublicDemo = (host: HTMLElement, options: PublicDemoOptions) => PublicDemoHandle;

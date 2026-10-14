import { BaseScene } from './base/scene';
import { CircuitBreakerScene } from './circuit-breaker/scene';
import { DrillRigScene } from './drill-rig/scene';
import { PressureGaugeScene } from './pressure-gauge/scene';
import { sceneManifest } from './sceneManifest';

import type { SceneSlug } from './sceneManifest';
import type { ComponentType } from 'react';

export type SceneDefinition = {
  component: ComponentType;
  title: string;
};

export const sceneRegistry = {
  base: {
    ...sceneManifest.base,
    component: BaseScene,
  },
  'circuit-breaker': {
    ...sceneManifest['circuit-breaker'],
    component: CircuitBreakerScene,
  },
  'drill-rig': {
    ...sceneManifest['drill-rig'],
    component: DrillRigScene,
  },
  'pressure-gauge': {
    ...sceneManifest['pressure-gauge'],
    component: PressureGaugeScene,
  },
} satisfies Record<SceneSlug, SceneDefinition>;

export const isSceneSlug = (value: string): value is SceneSlug =>
  Object.hasOwn(sceneRegistry, value);

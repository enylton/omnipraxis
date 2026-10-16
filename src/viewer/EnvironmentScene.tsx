import { useCallback, useEffect, useState } from 'react';

import { GltfModel } from '../runtime/assets/GltfModel';
import { usePlayer } from '../runtime/player/PlayerContext';
import { SplatModel } from '../runtime/spark/SplatModel';

import type { SceneDescriptor } from '../contracts/scene';
import type { ResolvedSceneAssets } from './assets/storageAssets';
import type { Group } from 'three';

export type EnvironmentSceneProps = {
  descriptor: SceneDescriptor;
  assets: ResolvedSceneAssets;
  onReady: () => void;
  onModelLoaded: (scene: Group) => void;
};

export const EnvironmentScene = ({
  descriptor,
  assets,
  onReady,
  onModelLoaded,
}: EnvironmentSceneProps) => {
  const { spawn } = usePlayer();
  const [splatsReady, setSplatsReady] = useState(false);
  const [collidersReady, setCollidersReady] = useState(false);
  const handleSplatsReady = useCallback(() => setSplatsReady(true), []);
  const handleCollidersReady = useCallback(
    (scene: Group) => {
      onModelLoaded(scene);
      setCollidersReady(true);
    },
    [onModelLoaded],
  );

  useEffect(() => {
    if (!splatsReady || !collidersReady) return;
    spawn(descriptor.spawn.position, descriptor.spawn.yaw, descriptor.spawn.pitch);
    onReady();
  }, [collidersReady, descriptor, onReady, spawn, splatsReady]);

  return (
    <group>
      <SplatModel
        url={assets.splatsUrl}
        format={descriptor.assets.splats.format}
        paged={descriptor.assets.splats.format === 'rad'}
        resolvePageUrl={assets.resolvePageUrl}
        onInitialized={handleSplatsReady}
      />
      <GltfModel
        url={assets.collidersUrl}
        visible={false}
        physicality="fixed"
        onReady={handleCollidersReady}
      />
    </group>
  );
};

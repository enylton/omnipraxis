import { useCallback, useEffect, useState } from 'react';

import { GltfModel } from '../runtime/assets/GltfModel';
import { usePlayer } from '../runtime/player/PlayerContext';
import { SplatModel } from '../runtime/spark/SplatModel';

import type { ViewerScene } from './scene';
import type { Group } from 'three';

export type EnvironmentSceneProps = {
  scene: ViewerScene;
  onReady: () => void;
  onModelLoaded: (scene: Group) => void;
};

export const EnvironmentScene = ({ scene, onReady, onModelLoaded }: EnvironmentSceneProps) => {
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
    spawn(scene.spawn.position, scene.spawn.yaw, scene.spawn.pitch);
    onReady();
  }, [collidersReady, onReady, scene, spawn, splatsReady]);

  return (
    <group>
      <SplatModel
        url={scene.assets.splatsUrl}
        format={scene.assets.splatsFormat}
        paged={scene.assets.splatsFormat === 'rad'}
        resolvePageUrl={scene.assets.resolvePageUrl}
        onInitialized={handleSplatsReady}
      />
      <GltfModel
        url={scene.assets.collidersUrl}
        visible={false}
        physicality="fixed"
        onReady={handleCollidersReady}
      />
    </group>
  );
};

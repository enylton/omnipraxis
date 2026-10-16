import { GltfModel } from '../../runtime/assets/GltfModel';
import { SplatModel } from '../../runtime/spark/SplatModel';
import { useSceneReadiness } from '../useSceneReadiness';

const SCENE_SPLATS_URL = `${import.meta.env.BASE_URL}scenes/base/splats.spz`;
const SCENE_COLLIDERS_URL = `${import.meta.env.BASE_URL}scenes/base/colliders.glb`;
const PLAYER_SPAWN_POSITION = [0, 0, 0] as const;

type BaseSceneProps = {
  splatsUrl?: string;
  collidersUrl?: string;
  onReady?: () => void;
};

export const BaseScene = ({
  splatsUrl = SCENE_SPLATS_URL,
  collidersUrl = SCENE_COLLIDERS_URL,
  onReady,
}: BaseSceneProps) => {
  const readiness = useSceneReadiness(PLAYER_SPAWN_POSITION, onReady);

  return (
    <group>
      <SplatModel url={splatsUrl} format="spz" onInitialized={readiness.splatsReady} />
      <GltfModel
        url={collidersUrl}
        opacity={0}
        physicality="fixed"
        onReady={readiness.collidersReady}
      />
    </group>
  );
};

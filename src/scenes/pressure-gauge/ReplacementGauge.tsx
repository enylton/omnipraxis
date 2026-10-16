import { GltfModel } from '../../runtime/assets/GltfModel';

import type { PlayerInteraction } from '../../runtime/player/PlayerContext';

type ReplacementGaugeProps = {
  url?: string;
  carried?: boolean;
  interaction?: PlayerInteraction | null;
};

const MANOMETRO_URL = `${import.meta.env.BASE_URL}assets/manometro.glb`;

export const ReplacementGauge = ({
  url = MANOMETRO_URL,
  carried = false,
  interaction = null,
}: ReplacementGaugeProps) => (
  <group
    name="replacement-pressure-gauge"
    position={carried ? [0, 0, 0] : [-6.6, 1, 1.6]}
    rotation={carried ? [0, 0, 0] : [0, 1.5, 0]}
    scale={0.3}
  >
    <GltfModel
      url={url}
      position={[-0.9, -3, 0]}
      interaction={interaction}
      blocksInteractions={!carried}
    />
  </group>
);

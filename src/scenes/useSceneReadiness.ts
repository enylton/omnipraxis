import { useCallback, useEffect, useState } from 'react';

import { usePlayer } from '../runtime/player/PlayerContext';

export function useSceneReadiness(
  position: readonly [number, number, number],
  onReady?: () => void,
) {
  const { spawn } = usePlayer();
  const [splats, setSplats] = useState(false);
  const [colliders, setColliders] = useState(false);
  const splatsReady = useCallback(() => setSplats(true), []);
  const collidersReady = useCallback(() => setColliders(true), []);
  useEffect(() => {
    if (!splats || !colliders) return;
    spawn(position);
    onReady?.();
  }, [colliders, onReady, position, spawn, splats]);
  return { splatsReady, collidersReady };
}

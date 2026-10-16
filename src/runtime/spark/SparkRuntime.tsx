import { extend, useThree } from '@react-three/fiber';
import { useMemo } from 'react';

import { ManagedSparkRenderer } from './compat/ManagedSparkRenderer';

import type { SparkRendererOptions } from '@sparkjsdev/spark';

const SparkRenderer = extend(ManagedSparkRenderer);

export const SparkRuntime = () => {
  const renderer = useThree((state) => state.gl);
  const sparkRendererArgs = useMemo<SparkRendererOptions>(() => ({ renderer }), [renderer]);

  return <SparkRenderer args={[sparkRendererArgs]} />;
};

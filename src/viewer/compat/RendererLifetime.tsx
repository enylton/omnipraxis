import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';

// R3F 9.6.1 teardown ordering workaround; see docs/spark-compatibility.md.
export const RendererLifetime = () => {
  const renderer = useThree((state) => state.gl);
  useEffect(
    () => () => {
      // R3F performs context/scene teardown after 500 ms. Keep renderer caches
      // available for pending Spark work until that step has finished.
      setTimeout(() => renderer.dispose(), 600);
    },
    [renderer],
  );
  return null;
};

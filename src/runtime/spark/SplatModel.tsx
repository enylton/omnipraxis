import { extend } from '@react-three/fiber';
import { SplatFileType, SplatMesh as SplatMeshImpl } from '@sparkjsdev/spark';
import { useEffect, useMemo, useRef, useState } from 'react';

import { createPagedSplats } from './compat/pagedSplats';

import type { SplatMeshOptions } from '@sparkjsdev/spark';
import type { ReactNode } from 'react';

const SplatMesh = extend(SplatMeshImpl);

type SplatModelProps = {
  url: string;
  paged?: boolean;
  format?: 'spz' | 'rad';
  resolvePageUrl?: (filename: string) => string;
  onInitialized?: () => void;
  children?: ReactNode;
};

export const SplatModel = ({
  children,
  url,
  paged = false,
  format,
  resolvePageUrl,
  onInitialized,
}: SplatModelProps) => {
  const splatMeshRef = useRef<SplatMeshImpl | null>(null);
  const activeMeshRef = useRef<SplatMeshImpl | null>(null);
  const initializedRef = useRef<SplatMeshImpl | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const splatMeshArgs = useMemo<[SplatMeshOptions]>(
    () => [
      {
        url,
        paged: resolvePageUrl ? createPagedSplats(url, resolvePageUrl) : paged,
        fileType:
          format === 'spz' ? SplatFileType.SPZ : format === 'rad' ? SplatFileType.RAD : undefined,
      },
    ],
    [format, paged, resolvePageUrl, url],
  );

  useEffect(() => {
    let cancelled = false;

    const waitForSplat = async () => {
      const splatMesh = splatMeshRef.current;

      if (!splatMesh) {
        return;
      }

      try {
        await splatMesh.initialized;
        if (!cancelled && initializedRef.current !== splatMesh) {
          initializedRef.current = splatMesh;
          onInitialized?.();
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason : new Error(String(reason)));
      }
    };

    void waitForSplat();

    return () => {
      cancelled = true;
    };
  }, [onInitialized, splatMeshArgs]);

  // Keep the Spark 2.1.0 mesh-lifetime workaround in this effect so Strict Mode
  // cleanup can distinguish an active mesh. See docs/spark-compatibility.md.
  useEffect(() => {
    const mesh = splatMeshRef.current;
    activeMeshRef.current = mesh;
    const initialLodTexture = mesh?.context.lodIndices.value;
    return () => {
      if (activeMeshRef.current === mesh) activeMeshRef.current = null;
      // Spark shares its initial LoD texture across meshes. Retiring its GPU
      // registrations prevents it from retaining every renderer it has visited.
      initialLodTexture?.dispose();
      // Initialization can finish after R3F has removed the object.
      if (mesh && !mesh.isInitialized) {
        const release = () => {
          // Strict Mode may remount this effect while the same mesh is loading.
          if (activeMeshRef.current !== mesh) mesh.dispose();
        };
        void mesh.initialized.then(release, release);
      }
    };
  }, [splatMeshArgs]);

  if (error) throw error;

  return (
    <SplatMesh ref={splatMeshRef} args={splatMeshArgs}>
      {children}
    </SplatMesh>
  );
};

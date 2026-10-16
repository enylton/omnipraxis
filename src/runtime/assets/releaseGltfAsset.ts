import { useGLTF } from '@react-three/drei';
import { Mesh, Texture } from 'three';

import type { Group, Material } from 'three';

// Only call for URLs owned exclusively by the disposed viewer session.
export const releaseGltfAsset = (url: string, scene: Group): void => {
  useGLTF.clear(url);
  const geometries = new Set<Mesh['geometry']>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
};

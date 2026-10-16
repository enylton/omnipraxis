import { SparkRenderer, SplatAccumulator } from '@sparkjsdev/spark';
import { Texture } from 'three';

import type { SparkRendererOptions } from '@sparkjsdev/spark';

// Spark 2.1.0 shutdown/resource workarounds; see docs/spark-compatibility.md.
export class ManagedSparkRenderer extends SparkRenderer {
  private disposing = false;
  private readonly fallbackTextures: Texture[] = [];

  constructor(options: SparkRendererOptions) {
    super(options);
    for (const uniform of Object.values(this.uniforms)) {
      if (uniform.value instanceof Texture) this.fallbackTextures.push(uniform.value);
    }
  }

  override dispose() {
    if (this.disposing) return;
    this.disposing = true;
    this.autoUpdate = false;
    this.enableDriveLod = false;
    this.enableLodFetching = false;
    this.sortDirty = false;
    clearTimeout(this.updateTimeoutId);
    clearTimeout(this.sortTimeoutId);

    // Spark rejects pending worker calls when terminated. Let its active sort/LoD
    // calls finish before releasing workers, rather than causing unhandled rejections.
    const finish = () => {
      if (
        this.sorting ||
        Object.keys(this.sortWorker?.messages ?? {}).length ||
        Object.keys(this.lodWorker?.messages ?? {}).length
      ) {
        setTimeout(finish, 10);
        return;
      }
      super.dispose();
      for (const texture of this.fallbackTextures) texture.dispose();
      // Spark's shared full-screen geometry also needs to release each renderer's
      // buffer registrations. It remains reusable on the next mount.
      SplatAccumulator.fullScreenQuad.dispose();
      this.material.dispose();
      this.geometry.dispose();
    };
    finish();
  }
}

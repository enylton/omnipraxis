import { PagedSplats, SplatFileType } from '@sparkjsdev/spark';

export const createPagedSplats = (
  rootUrl: string,
  resolvePageUrl: (filename: string) => string,
): PagedSplats => {
  const splats = new PagedSplats({ rootUrl, fileType: SplatFileType.RAD });
  // Spark 2.1.0 has no page URL callback. Adapt only this instance's metadata;
  // URL construction and access policy belong to the caller. See docs/spark-compatibility.md.
  splats.radMetaPromise = splats.getRadMeta().then(({ meta, chunksStart }) => ({
    chunksStart,
    meta: {
      ...meta,
      chunks: meta.chunks.map((chunk) => ({
        ...chunk,
        filename: chunk.filename ? resolvePageUrl(chunk.filename) : undefined,
      })),
    },
  }));
  return splats;
};

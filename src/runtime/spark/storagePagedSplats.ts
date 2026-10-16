import { PagedSplats, SplatFileType } from '@sparkjsdev/spark';

export const createStoragePagedSplats = (
  rootUrl: string,
  resolvePageUrl: (filename: string) => string,
): PagedSplats => {
  const splats = new PagedSplats({ rootUrl, fileType: SplatFileType.RAD });
  // Firebase's media endpoint encodes the full object path. Relative URL resolution
  // would lose that path. Adapt this instance's metadata, never the global fetch API.
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

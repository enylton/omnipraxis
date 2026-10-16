declare module 'gltf-validator' {
  export function validateBytes(
    bytes: Uint8Array,
    options: {
      format: 'glb';
      maxIssues: number;
      externalResourceFunction: (uri: string) => Promise<Uint8Array>;
    },
  ): Promise<{ issues: { numErrors: number; messages: { code: string; message: string }[] } }>;
}

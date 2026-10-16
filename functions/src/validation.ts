import { Readable } from 'node:stream';
import { createGunzip, crc32, inflateSync } from 'node:zlib';

import { validateBytes } from 'gltf-validator';

export const slots = ['splats.spz', 'colliders.glb', 'thumbnail.png'] as const;
export type Slot = (typeof slots)[number];
export const chunkBytes = 1024 * 1024;
export const limits = {
  'splats.spz': 100 * 1024 ** 2,
  'colliders.glb': 100 * 1024 ** 2,
  'thumbnail.png': 5 * 1024 ** 2,
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const integer = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

async function splats(bytes: Buffer) {
  check(bytes[0] === 31 && bytes[1] === 139, 'Use gzip SPZ version 2 or 3.');
  const stream = Readable.from([bytes]).pipe(createGunzip());
  let header = Buffer.alloc(0);
  let size = 0;
  let expected = 0;
  for await (const value of stream) {
    const part = value as Buffer;
    size += part.length;
    check(size <= 128 * 1024 ** 2, 'SPZ decoded data exceeds 128 MiB.');
    if (header.length < 16) header = Buffer.concat([header, part.subarray(0, 16 - header.length)]);
    if (!expected && header.length === 16) {
      const version = header.readUInt32LE(4);
      const count = header.readUInt32LE(8);
      const degree = header[12];
      check(
        header.readUInt32LE(0) === 0x5053474e &&
          [2, 3].includes(version) &&
          count > 0 &&
          count <= 3_000_000 &&
          degree <= 3 &&
          header[13] <= 24 &&
          header[14] <= 1 &&
          header[15] === 0,
        'Unsupported SPZ header or point count.',
      );
      expected = 16 + count * (version === 3 ? 20 : 19) + count * [0, 9, 24, 45][degree];
    }
    if (expected) check(size <= expected, 'Unexpected SPZ attribute data.');
  }
  check(expected > 0 && size === expected, 'Incomplete SPZ attribute data.');
}

type Accessor = {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: unknown;
};
type View = { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number };
type Node = {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};
function colliders(bytes: Buffer) {
  check(
    bytes.length >= 28 &&
      bytes.readUInt32LE(0) === 0x46546c67 &&
      bytes.readUInt32LE(4) === 2 &&
      bytes.readUInt32LE(8) === bytes.length,
    'Invalid GLB 2 header.',
  );
  const jsonLength = bytes.readUInt32LE(12);
  check(
    jsonLength <= 2 * 1024 ** 2 &&
      jsonLength % 4 === 0 &&
      28 + jsonLength <= bytes.length &&
      bytes.readUInt32LE(16) === 0x4e4f534a,
    'Invalid or oversized GLB JSON chunk.',
  );
  const binStart = 28 + jsonLength;
  const binSize = bytes.readUInt32LE(20 + jsonLength);
  check(
    bytes.readUInt32LE(24 + jsonLength) === 0x004e4942 &&
      binSize % 4 === 0 &&
      binStart + binSize === bytes.length,
    'Require exactly one embedded GLB binary chunk.',
  );
  const model = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as {
    asset: { version: string };
    buffers: { byteLength: number; uri?: unknown }[];
    bufferViews: View[];
    accessors: Accessor[];
    nodes: Node[];
    meshes: {
      primitives: {
        attributes: Record<string, number>;
        indices?: number;
        mode?: number;
        targets?: unknown;
      }[];
    }[];
    scenes: { nodes: number[] }[];
    scene?: number;
    images?: unknown[];
    textures?: unknown[];
    skins?: unknown[];
    animations?: unknown[];
  };
  check(
    model.asset?.version === '2.0' &&
      Array.isArray(model.buffers) &&
      model.buffers.length === 1 &&
      model.buffers[0].uri === undefined &&
      integer(model.buffers[0].byteLength, binSize) &&
      binSize - model.buffers[0].byteLength < 4,
    'GLB buffers must be embedded.',
  );
  const rejectDependencies = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      check(
        !['uri', 'extensions', 'extensionsUsed', 'extensionsRequired'].includes(key),
        'Collider GLB must have no URIs or extensions.',
      );
      rejectDependencies(child);
    }
  };
  rejectDependencies(model);
  check(
    !model.images?.length &&
      !model.textures?.length &&
      !model.skins?.length &&
      !model.animations?.length,
    'Use static collider geometry without images, skins or animations.',
  );
  check(
    Array.isArray(model.nodes) &&
      model.nodes.length > 0 &&
      model.nodes.length <= 1000 &&
      Array.isArray(model.meshes) &&
      model.meshes.length > 0 &&
      model.meshes.length <= 500 &&
      Array.isArray(model.scenes) &&
      model.scenes.length <= 10,
    'Collider scene/mesh/node limits exceeded.',
  );
  check(
    Array.isArray(model.bufferViews) &&
      model.bufferViews.length <= 5000 &&
      Array.isArray(model.accessors) &&
      model.accessors.length <= 5000,
    'Invalid collider views/accessors.',
  );
  for (const view of model.bufferViews)
    check(
      view.buffer === 0 &&
        integer(view.byteOffset ?? 0, binSize) &&
        integer(view.byteLength, binSize) &&
        (view.byteOffset ?? 0) + view.byteLength <= model.buffers[0].byteLength &&
        (view.byteStride === undefined || (integer(view.byteStride, 252) && view.byteStride >= 4)),
      'Invalid collider buffer view.',
    );
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let componentsTotal = 0;
  for (const accessor of model.accessors) {
    const view = model.bufferViews[accessor.bufferView];
    const packed = components[accessor.type] * sizes[accessor.componentType];
    const stride = view?.byteStride ?? packed;
    componentsTotal += accessor.count * components[accessor.type];
    check(componentsTotal <= 30_000_000, 'Collider accessor work limit exceeded.');
    check(
      view &&
        !accessor.sparse &&
        packed &&
        stride >= packed &&
        integer(accessor.count, 3_000_000) &&
        accessor.count > 0 &&
        integer(accessor.byteOffset ?? 0, view.byteLength) &&
        (accessor.byteOffset ?? 0) + (accessor.count - 1) * stride + packed <= view.byteLength,
      'Invalid collider accessor bounds.',
    );
  }
  let triangles = 0;
  let verticesScanned = 0;
  const meshTriangles: number[] = [];
  for (const mesh of model.meshes) {
    const before = triangles;
    check(
      Array.isArray(mesh.primitives) && mesh.primitives.length <= 100,
      'Too many collider primitives.',
    );
    for (const primitive of mesh.primitives) {
      const position = model.accessors[primitive.attributes?.POSITION];
      check(
        position?.componentType === 5126 &&
          position.type === 'VEC3' &&
          !primitive.targets &&
          (primitive.mode ?? 4) === 4,
        'Collider primitives must be static float triangle geometry.',
      );
      for (const index of Object.values(primitive.attributes))
        check(integer(index, model.accessors.length - 1), 'Invalid collider attribute reference.');
      const view = model.bufferViews[position.bufferView];
      verticesScanned += position.count;
      check(verticesScanned <= 3_000_000, 'Collider vertex work limit exceeded.');
      const offset = binStart + (view.byteOffset ?? 0) + (position.byteOffset ?? 0);
      for (let i = 0; i < position.count; i++)
        for (let axis = 0; axis < 3; axis++) {
          const value = bytes.readFloatLE(offset + i * (view.byteStride ?? 12) + axis * 4);
          check(
            Number.isFinite(value) && Math.abs(value) <= 100_000,
            'Collider coordinate is not finite or bounded.',
          );
        }
      let count = position.count;
      if (primitive.indices !== undefined) {
        const accessor = model.accessors[primitive.indices];
        check(
          accessor &&
            accessor.type === 'SCALAR' &&
            [5121, 5123, 5125].includes(accessor.componentType),
          'Invalid collider indices.',
        );
        const view = model.bufferViews[accessor.bufferView];
        const width = sizes[accessor.componentType];
        const offset = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        for (let i = 0; i < accessor.count; i++)
          check(
            bytes.readUIntLE(offset + i * (view.byteStride ?? width), width) < position.count,
            'Collider index exceeds its vertices.',
          );
        count = accessor.count;
      }
      check(count % 3 === 0, 'Incomplete collider triangle.');
      triangles += count / 3;
      check(triangles <= 1_000_000, 'Collider exceeds one million triangles.');
    }
    meshTriangles.push(triangles - before);
  }
  check(
    model.nodes.reduce(
      (total, node) =>
        total + (node.mesh === undefined ? 0 : (meshTriangles[node.mesh] ?? 1_000_001)),
      0,
    ) <= 1_000_000,
    'Instanced collider triangle limit exceeded.',
  );
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (index: number) => {
    check(
      integer(index, model.nodes.length - 1) && !visiting.has(index),
      'Invalid or cyclic collider node.',
    );
    if (visited.has(index)) return;
    visiting.add(index);
    const node = model.nodes[index];
    check(
      node.mesh === undefined || integer(node.mesh, model.meshes.length - 1),
      'Invalid collider mesh reference.',
    );
    for (const [key, length] of [
      ['matrix', 16],
      ['translation', 3],
      ['rotation', 4],
      ['scale', 3],
    ] as const) {
      const vector = node[key];
      check(
        vector === undefined ||
          (Array.isArray(vector) &&
            vector.length === length &&
            vector.every(
              (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000,
            )),
        'Invalid collider transform.',
      );
    }
    check(
      node.children === undefined || (Array.isArray(node.children) && node.children.length <= 1000),
      'Invalid collider hierarchy.',
    );
    for (const child of node.children ?? []) visit(child);
    visiting.delete(index);
    visited.add(index);
  };
  for (const scene of model.scenes) {
    check(Array.isArray(scene.nodes) && scene.nodes.length <= 1000, 'Invalid collider roots.');
    for (const root of scene.nodes) visit(root);
  }
  for (let i = 0; i < model.nodes.length; i++) visit(i);
  check(
    model.scenes.length > 0 && integer(model.scene ?? 0, model.scenes.length - 1) && triangles > 0,
    'Collider has no usable scene.',
  );
}

function thumbnail(bytes: Buffer) {
  check(
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    'Thumbnail must be PNG.',
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let ended = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    check(
      end <= bytes.length &&
        crc32(bytes.subarray(offset + 4, end - 4)) === bytes.readUInt32BE(end - 4),
      'Invalid PNG chunk/checksum.',
    );
    if (offset === 8) {
      check(type === 'IHDR' && length === 13, 'Invalid PNG header.');
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      channels = bytes[offset + 17] === 6 ? 4 : 3;
      check(
        width > 0 &&
          height > 0 &&
          width <= 2048 &&
          height <= 2048 &&
          bytes[offset + 16] === 8 &&
          [2, 6].includes(bytes[offset + 17]) &&
          bytes[offset + 18] === 0 &&
          bytes[offset + 19] === 0 &&
          bytes[offset + 20] === 0,
        'Use noninterlaced 8-bit RGB/RGBA PNG up to 2048×2048.',
      );
    } else if (type === 'IDAT') data.push(bytes.subarray(offset + 8, end - 4));
    else if (type === 'IEND') {
      check(length === 0 && end === bytes.length, 'Invalid PNG end.');
      ended = true;
    } else
      check(['sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type), 'Unsupported thumbnail PNG chunk.');
    offset = end;
  }
  check(ended && data.length && offset === bytes.length, 'Incomplete PNG.');
  const expected = (width * channels + 1) * height;
  const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  check(decoded.length === expected, 'Incomplete PNG pixels.');
  for (let row = 0; row < height; row++)
    check(decoded[row * (width * channels + 1)] <= 4, 'Invalid PNG scanline filter.');
}
export async function validateAsset(slot: Slot, bytes: Buffer) {
  check(bytes.length > 0 && bytes.length <= limits[slot], 'Asset size exceeds its slot.');
  if (slot === 'splats.spz') await splats(bytes);
  else if (slot === 'colliders.glb') {
    colliders(bytes);
    const report = await validateBytes(bytes, {
      format: 'glb',
      maxIssues: 100,
      externalResourceFunction: async () => {
        throw new Error('External resources are not allowed.');
      },
    });
    check(report.issues.numErrors === 0, 'Collider failed Khronos glTF validation.');
  } else thumbnail(bytes);
}

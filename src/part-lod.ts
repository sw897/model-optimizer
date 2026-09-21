import { MeshoptSimplifier } from "meshoptimizer";
import { parseGLB, type JSONObject } from "./resource-graph.js";
import type { PresetLevel, PrototypeStats } from "./types.js";

export class PartLODUnsupported extends Error {}

export function encodePartGLB(json: JSONObject, binary: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(json));
  const jsonLength = text.length + (8 - (28 + text.length) % 8) % 8;
  const binLength = binary.length + (8 - binary.length % 8) % 8;
  const result = Buffer.alloc(28 + jsonLength + binLength);
  result.write("glTF"); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12); result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(32, 20, 20 + jsonLength); text.copy(result, 20);
  result.writeUInt32LE(binLength, 20 + jsonLength); result.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(result, 28 + jsonLength);
  return result;
}

export async function simplifyPartGLB(bytes: Buffer, level: PresetLevel): Promise<{ bytes: Buffer; error: number; sourceStats: PrototypeStats; stats: PrototypeStats }> {
  const { json: source, binary } = parseGLB(bytes, "part prototype");
  const reject = (reason: string): never => { throw new PartLODUnsupported(`part feature ownership/survival: ${reason}; preserve base-only prototype`); };
  if (!binary || source.buffers?.length !== 1 || source.buffers[0].uri || !Number.isSafeInteger(source.buffers[0].byteLength) || source.buffers[0].byteLength < 0 || source.buffers[0].byteLength > binary.length) reject("requires one embedded uncompressed buffer");
  if (source.animations?.length || source.skins?.length || (source.nodes ?? []).some((n: JSONObject) => n.matrix || n.scale?.some((v: number) => v !== 1))) reject("animated or scaled prototypes are unsupported");
  if ((source.extensionsUsed ?? []).some((name: string) => !["EXT_structural_metadata", "EXT_mesh_features"].includes(name))) reject("unsupported extension");
  const tables = source.extensions?.EXT_structural_metadata?.propertyTables;
  if (!tables?.length || tables.some((t: JSONObject) => t.class !== "prototype_parts")) reject("requires canonical part property tables");
  const json = structuredClone(source);
  const replacements = new Map<number, Buffer>();
  const usedAccessors = new Set<number>();
  const accessors = source.accessors ?? [];
  const views = source.bufferViews ?? [];
  const widths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const elements: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const geometryViews = new Set<number>();
  const read = (index: number): { accessor: JSONObject; bytes: Buffer; width: number } => {
    const a = accessors[index], v = views[a?.bufferView];
    if (!a || !v || a.sparse || a.extensions || v.extensions || v.buffer !== 0 || v.byteStride || (a.byteOffset ?? 0) !== 0) reject("unsupported accessor layout");
    const width = (widths[a.componentType] ?? 0) * (elements[a.type] ?? 0);
    if (!width || !Number.isSafeInteger(a.count) || a.count < 1 || v.byteLength !== a.count * width || (v.byteOffset ?? 0) < 0 || (v.byteOffset ?? 0) + v.byteLength > binary!.length) reject("invalid accessor range");
    if (accessors.filter((other: JSONObject) => other.bufferView === a.bufferView).length !== 1) reject("shared geometry bufferView");
    return { accessor: a, bytes: binary!.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength), width };
  };
  const scalar = (b: Buffer, offset: number, type: number): number => {
    switch (type) {
      case 5120: return b.readInt8(offset);
      case 5121: return b.readUInt8(offset);
      case 5122: return b.readInt16LE(offset);
      case 5123: return b.readUInt16LE(offset);
      case 5125: return b.readUInt32LE(offset);
      case 5126: return b.readFloatLE(offset);
      default: return reject("invalid component type");
    }
  };
  const sourceStats: PrototypeStats = { meshes: json.meshes?.length ?? 0, primitives: 0, triangleCount: 0, vertexCount: 0, unsupportedPrimitives: 0, unsupportedModes: [] };
  let triangles = 0, vertices = 0, maximumError = 0;
  await MeshoptSimplifier.ready;
  for (const mesh of json.meshes ?? []) for (const p of mesh.primitives) {
    if ((p.mode ?? 4) !== 4 || p.targets?.length || Object.keys(p.extensions ?? {}).some(k => k !== "EXT_mesh_features")) reject("requires static indexed triangle primitives");
    const sets = p.extensions?.EXT_mesh_features?.featureIds;
    if (!sets?.length) reject("primitive has no part feature set");
    const position = read(p.attributes.POSITION), indices = read(p.indices);
    if (position.accessor.type !== "VEC3" || position.accessor.componentType !== 5126 || position.accessor.normalized || indices.accessor.type !== "SCALAR" || indices.accessor.normalized || ![5121,5123,5125].includes(indices.accessor.componentType) || indices.accessor.count % 3) reject("invalid triangle positions or indices");
    const indexArray = Uint32Array.from({ length: indices.accessor.count }, (_, i) => scalar(indices.bytes, i * indices.width, indices.accessor.componentType));
    if (indexArray.some(i => i >= position.accessor.count)) reject("triangle index out of range");
    const attributes = Object.entries(p.attributes).map(([semantic, index]) => ({ semantic, index: index as number, ...read(index as number) }));
    for (const a of attributes) {
      if (a.accessor.count !== position.accessor.count) reject("attribute count mismatch");
    }
    for (const set of sets) {
      const table = tables[set.propertyTable];
      if (!table || !Number.isSafeInteger(set.featureCount) || set.featureCount < 1 || set.featureCount > table.count || !Number.isInteger(set.attribute) || set.texture) reject("invalid part feature set");
      const feature = attributes.find(a => a.semantic === `_FEATURE_ID_${set.attribute}`);
      if (!feature || feature.accessor.type !== "SCALAR" || feature.accessor.normalized) reject("missing part feature attribute");
      const values = indexArray.map(i => scalar(feature!.bytes, i * feature!.width, feature!.accessor.componentType));
      if (!values.length || values.some(id => id !== values[0] || id >= set.featureCount || id === set.nullFeatureId)) reject("mixed part primitive");
      for (const i of indexArray) {
        const id = scalar(feature!.bytes, i * feature!.width, feature!.accessor.componentType);
        if (!Number.isSafeInteger(id) || id < 0 || id !== values[0]) reject("invalid part identity");
      }
    }
    for (const index of [p.indices, ...attributes.map(a => a.index)]) {
      if (usedAccessors.has(index)) reject("shared primitive accessors");
      usedAccessors.add(index); geometryViews.add(accessors[index].bufferView);
    }
    const positions = Float32Array.from({ length: position.accessor.count * 3 }, (_, i) => position.bytes.readFloatLE(i * 4));
    if (positions.some(v => !Number.isFinite(v))) reject("non-finite position");
    const scale = MeshoptSimplifier.getScale(positions, 3);
    const target = Math.max(3, Math.floor(indexArray.length * level.ratio / 3) * 3);
    let reduced = indexArray, error = 0;
    if (scale > 0 && target < indexArray.length) {
      [reduced, error] = MeshoptSimplifier.simplify(indexArray, positions, 3, target, level.maxErrorMeters / scale, level.lockBorder ? ["LockBorder"] : []);
      if (reduced.length >= indexArray.length) [reduced, error] = MeshoptSimplifier.simplifySloppy(indexArray, positions, 3, null, target, level.maxErrorMeters / scale);
      if (!reduced.length) { reduced = indexArray; error = 0; }
      if (!Number.isFinite(error) || error * scale > level.maxErrorMeters + 1e-6) reject("measured error exceeds limit");
    }
    maximumError = Math.max(maximumError, error * scale);
    const remap = new Map<number, number>();
    for (const old of reduced) if (!remap.has(old)) remap.set(old, remap.size);
    const newIndices = Buffer.alloc(reduced.length * 4);
    reduced.forEach((old, i) => newIndices.writeUInt32LE(remap.get(old)!, i * 4));
    replacements.set(indices.accessor.bufferView, newIndices);
    Object.assign(json.accessors[p.indices], { count: reduced.length, componentType: 5125 });
    delete json.accessors[p.indices].min; delete json.accessors[p.indices].max;
    for (const a of attributes) {
      const data = Buffer.alloc(remap.size * a.width);
      for (const [old, index] of remap) a.bytes.copy(data, index * a.width, old * a.width, (old + 1) * a.width);
      replacements.set(a.accessor.bufferView, data);
      const updated = json.accessors[a.index]; updated.count = remap.size;
      if (updated.min || updated.max) {
        const count = elements[a.accessor.type]!; const width = widths[a.accessor.componentType]!;
        const min = Array<number>(count).fill(Infinity), max = Array<number>(count).fill(-Infinity);
        for (let i = 0; i < remap.size; i++) for (let k = 0; k < count; k++) {
          const value = scalar(data, i * a.width + k * width, a.accessor.componentType);
          min[k] = Math.min(min[k]!, value); max[k] = Math.max(max[k]!, value);
        }
        if (updated.min) updated.min = min;
        if (updated.max) updated.max = max;
      }
    }
    sourceStats.primitives++; sourceStats.triangleCount += indexArray.length / 3; sourceStats.vertexCount += position.accessor.count;
    triangles += reduced.length / 3; vertices += remap.size;
  }
  if (triangles >= sourceStats.triangleCount) throw new PartLODUnsupported("no-reduction: part-preserving simplification did not reduce triangles");
  const assertSeparateMetadata = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(assertSeparateMetadata); return; }
    for (const [key,v] of Object.entries(value)) {
      if (["values","stringOffsets","arrayOffsets","bufferView"].includes(key) && typeof v === "number" && geometryViews.has(v)) reject("metadata aliases geometry bufferView");
      assertSeparateMetadata(v);
    }
  };
  assertSeparateMetadata(json.extensions); assertSeparateMetadata(json.images);
  const parts: Buffer[] = []; let length = 0;
  json.bufferViews.forEach((v: JSONObject, i: number) => {
    if (v.buffer !== 0 || v.extensions || !Number.isSafeInteger(v.byteLength) || v.byteLength < 0 || (v.byteOffset ?? 0) < 0 || (v.byteOffset ?? 0) + v.byteLength > binary!.length) reject("invalid bufferView");
    const data = replacements.get(i) ?? binary!.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    const padding = (8 - length % 8) % 8; if (padding) { parts.push(Buffer.alloc(padding)); length += padding; }
    v.byteOffset = length; v.byteLength = data.length; parts.push(data); length += data.length;
  });
  json.buffers[0].byteLength = length;
  return { bytes: encodePartGLB(json, Buffer.concat(parts)), error: maximumError, sourceStats, stats: { ...sourceStats, triangleCount: triangles, vertexCount: vertices } };
}

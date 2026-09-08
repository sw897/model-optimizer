import { readFile } from "node:fs/promises";
import { resolveExistingSafe, sha256Buffer } from "./fs-utils.js";
import { dataURI, gltfBuffers, resourcePath, visitURIs, type JSONObject, type ResourceGraph } from "./resource-graph.js";

export async function packGLB(graph: ResourceGraph, path: string): Promise<Buffer> {
  const source = graph.documents.get(path);
  if (!source || !graph.gltfs.has(path)) throw new Error(`missing glTF document to embed: ${path}`);
  const json = structuredClone(source), buffers = await gltfBuffers(graph, path, source);
  const parts: Buffer[] = [], offsets: number[] = [], virtual: JSONObject[] = [], physical: JSONObject[] = [];
  const indices: number[] = [];
  let length = 0;
  const append = (bytes: Buffer): number => {
    const padding = (8 - length % 8) % 8;
    if (padding) { parts.push(Buffer.alloc(padding)); length += padding; }
    const offset = length;
    parts.push(bytes); length += bytes.length;
    if (!Number.isSafeInteger(length) || length > 0xffffffff) throw new Error(`embedded GLB exceeds the 4 GiB format limit: ${path}`);
    return offset;
  };
  for (let index = 0; index < buffers.length; index++) {
    const buffer = json.buffers[index] as JSONObject;
    const fallback = buffer.uri === undefined && buffer.extensions?.EXT_meshopt_compression?.fallback === true && buffers[index]!.length === 0;
    if (fallback) {
      indices[index] = virtual.length + 1; offsets[index] = 0;
      virtual.push(buffer);
    } else {
      physical.push(buffer);
      indices[index] = 0; offsets[index] = append(buffers[index]!);
    }
  }
  const remap = (value: JSONObject): void => {
    const index = value.buffer;
    if (!Number.isInteger(index) || indices[index] === undefined) throw new Error(`invalid embedded buffer index in ${path}`);
    const offset = value.byteOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || offset + value.byteLength > source.buffers[index].byteLength) {
      throw new Error(`invalid embedded buffer range in ${path}`);
    }
    value.buffer = indices[index]; value.byteOffset = offset + offsets[index]!;
  };
  for (const view of json.bufferViews ?? []) {
    remap(view);
    if (view.extensions?.EXT_meshopt_compression) remap(view.extensions.EXT_meshopt_compression);
  }
  const readURI = async (uri: string): Promise<Buffer> => uri.startsWith("data:")
    ? dataURI(uri)
    : readFile(await resolveExistingSafe(graph.root, resourcePath(path, uri)));
  const imageViews = new Map<string, number>();
  for (const image of json.images ?? []) {
    if (typeof image.uri !== "string") continue;
    const bytes = await readURI(image.uri);
    const mimeType = imageMIME(bytes);
    const views: JSONObject[] = json.bufferViews ??= [];
    const key = `${mimeType}:${await sha256Buffer(bytes)}`;
    let view = imageViews.get(key);
    if (view === undefined) {
      view = views.length;
      views.push({ buffer: 0, byteOffset: append(bytes), byteLength: bytes.length });
      imageViews.set(key, view);
    }
    image.bufferView = view;
    image.mimeType = mimeType;
    delete image.uri;
  }
  const metadata = json.extensions?.EXT_structural_metadata;
  if (typeof metadata?.schemaUri === "string") {
    if (metadata.schema !== undefined) throw new Error(`metadata declares both schema and schemaUri in ${path}`);
    metadata.schema = JSON.parse((await readURI(metadata.schemaUri)).toString("utf8"));
    delete metadata.schemaUri;
  }
  if (length > 0) {
    const binaryBuffer: JSONObject = physical.length === 1 ? { ...physical[0], byteLength: length } : { byteLength: length };
    delete binaryBuffer.uri;
    if (binaryBuffer.extensions?.EXT_meshopt_compression) {
      binaryBuffer.extensions = { ...binaryBuffer.extensions }; delete binaryBuffer.extensions.EXT_meshopt_compression;
      if (!Object.keys(binaryBuffer.extensions).length) delete binaryBuffer.extensions;
    }
    json.buffers = [binaryBuffer, ...virtual];
  } else if (virtual.length) {
    throw new Error(`Meshopt fallback has no encoded data in ${path}`);
  } else delete json.buffers;
  visitURIs(json, (_object, _key, uri) => {
    if (!uri.startsWith("data:")) throw new Error(`resource cannot be embedded in standalone GLB: ${path}: ${uri}`);
  });
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const alignment = json.extensions?.EXT_structural_metadata ? 8 : 4;
  const jsonLength = jsonBytes.length + (alignment - (28 + jsonBytes.length) % alignment) % alignment;
  const binLength = length + (alignment - length % alignment) % alignment;
  const total = 20 + jsonLength + (length ? 8 + binLength : 0);
  if (total > 0xffffffff) throw new Error(`embedded GLB exceeds the 4 GiB format limit: ${path}`);
  const result = Buffer.alloc(total);
  result.write("glTF"); result.writeUInt32LE(2, 4); result.writeUInt32LE(total, 8);
  result.writeUInt32LE(jsonLength, 12); result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(0x20, 20, 20 + jsonLength); jsonBytes.copy(result, 20);
  if (length) {
    result.writeUInt32LE(binLength, 20 + jsonLength); result.writeUInt32LE(0x004e4942, 24 + jsonLength);
    let offset = 28 + jsonLength;
    for (const part of parts) { part.copy(result, offset); offset += part.length; }
  }
  return result;
}

function imageMIME(bytes: Buffer): string {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 12).toString("hex") === "ab4b5458203230bb0d0a1a0a") return "image/ktx2";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(bytes.toString("ascii", 8, Math.min(bytes.length, 40)))) return "image/avif";
  if (bytes.toString("ascii", 0, 4) === "DDS ") return "image/vnd-ms.dds";
  throw new Error("unsupported embedded image format");
}

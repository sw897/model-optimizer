import { readFile, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { resolveExistingSafe, sha256Buffer, sha256File } from "./fs-utils.js";
import { loadPublicationManagement } from "./publication-index.js";

export type JSONObject = Record<string, any>;
export interface ResourceGraph {
  root: string;
  entry: string;
  files: Map<string, { sha256: string; bytes: number }>;
  documents: Map<string, JSONObject>;
  gltfs: Set<string>;
  hash: string;
}

export function resourcePath(owner: string, uri: string): string {
  if (!uri || /[\\\u0000]/.test(uri) || /^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith("/")) {
    throw new Error(`unsupported external resource URI in ${owner}: ${uri}`);
  }
  if (/[?#]/.test(uri)) throw new Error(`local resource URI must not contain query or fragment: ${uri}`);
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new Error(`invalid URI encoding: ${uri}`); }
  if (/[\\\u0000]/.test(decoded) || decoded.startsWith("/")) throw new Error(`unsafe resource URI: ${uri}`);
  const path = posix.normalize(posix.join(posix.dirname(owner), decoded));
  if (path === ".." || path.startsWith("../") || path === ".") throw new Error(`resource escapes input root: ${uri}`);
  return path;
}

export function relativeURI(owner: string, target: string): string {
  return posix.relative(posix.dirname(owner), target).split("/").map(encodeURIComponent).join("/");
}

export function dataURI(uri: string): Buffer {
  const match = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!match) throw new Error("invalid data URI");
  if (match[1]!.endsWith(";base64")) {
    if (!/^[\w+/]*={0,2}$/.test(match[2]!)) throw new Error("invalid base64 data URI");
    return Buffer.from(match[2]!, "base64");
  }
  const result: number[] = [];
  for (let index = 0; index < match[2]!.length; index++) {
    const character = match[2]![index]!;
    if (character === "%") {
      const hex = match[2]!.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("invalid data URI encoding");
      result.push(parseInt(hex, 16)); index += 2;
    } else result.push(...Buffer.from(character));
  }
  return Buffer.from(result);
}

export function parseGLB(bytes: Buffer, label: string): { json: JSONObject; binary?: Buffer } {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error(`invalid GLB header: ${label}`);
  }
  let json: JSONObject | undefined;
  let binary: Buffer | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error(`truncated GLB chunk: ${label}`);
    const size = bytes.readUInt32LE(offset);
    const kind = bytes.readUInt32LE(offset + 4);
    if (size % 4 || offset + 8 + size > bytes.length) throw new Error(`invalid GLB chunk length: ${label}`);
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (kind === 0x4e4f534a) {
      if (json || offset !== 12) throw new Error(`invalid GLB JSON chunk: ${label}`);
      json = JSON.parse(chunk.toString("utf8").replace(/[\u0000 ]+$/, "")) as JSONObject;
    } else if (kind === 0x004e4942) {
      if (binary) throw new Error(`duplicate GLB BIN chunk: ${label}`);
      binary = chunk;
    } else throw new Error(`unsupported GLB chunk type in ${label}`);
    offset += size + 8;
  }
  if (!json) throw new Error(`GLB missing JSON: ${label}`);
  return binary ? { json, binary } : { json };
}

export function visitURIs(value: unknown, callback: (object: JSONObject, key: string, uri: string) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) visitURIs(item, callback); return; }
  const object = value as JSONObject;
  for (const [key, entry] of Object.entries(object)) {
    if (key === "extras") continue;
    if ((key === "uri" || key === "schemaUri") && typeof entry === "string") callback(object, key, entry);
    else visitURIs(entry, callback);
  }
}

export async function loadResourceGraph(root: string, entry = "tileset.json"): Promise<ResourceGraph> {
  return loadGraph(root, [entry], true);
}

export async function loadGLTFResourceGraph(root: string, entries: string[]): Promise<ResourceGraph> {
  if (!entries.length || entries.some(entry => ![".glb", ".gltf"].includes(posix.extname(entry).toLowerCase()))) throw new Error("model input must contain GLB or glTF resources");
  return loadGraph(root, entries, false);
}

async function loadGraph(root: string, entries: string[], tileset: boolean): Promise<ResourceGraph> {
  const entry = entries[0]!;
  const graph: ResourceGraph = { root: resolve(root), entry, files: new Map(), documents: new Map(), gltfs: new Set(), hash: "" };
  const active = new Set<string>();
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error(`resource nesting exceeds 64 levels: ${path}`);
    if (active.has(path)) throw new Error(`cyclic resource reference: ${path}`);
    if (graph.files.has(path)) return;
    const absolute = await resolveExistingSafe(root, path);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`resource is not a file: ${path}`);
    graph.files.set(path, { sha256: await sha256File(absolute), bytes: info.size });
    const extension = posix.extname(path).toLowerCase();
    if (extension !== ".json" && extension !== ".gltf" && extension !== ".glb") return;
    active.add(path);
    const bytes = await readFile(absolute);
    const json = extension === ".glb" ? parseGLB(bytes, path).json : JSON.parse(bytes.toString("utf8")) as JSONObject;
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`invalid resource document: ${path}`);
    if (extension === ".gltf" || extension === ".glb") {
      if (json.asset?.version !== "2.0") throw new Error(`glTF asset must use version 2.0: ${path}`);
      graph.gltfs.add(path);
    } else if (tileset && path === entry && (!json.root || !["1.0", "1.1"].includes(json.asset?.version))) {
      throw new Error("input must contain a standard tileset.json");
    }
    graph.documents.set(path, json);
    const dependencies: string[] = [];
    visitURIs(json, (_object, _key, uri) => {
      if (uri.startsWith("data:")) { dataURI(uri); return; }
      dependencies.push(resourcePath(path, uri));
    });
    for (const dependency of dependencies) await visit(dependency, depth + 1);
    active.delete(path);
  };
  for (const path of entries) await visit(path, 0);
  await hashGraph(graph);
  return graph;
}

export async function hashGraph(graph: ResourceGraph): Promise<void> {
  const records = [...graph.files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  graph.hash = await sha256Buffer(Buffer.from(records.map(([path, value]) => `${path}\n${value.sha256}\n`).join("")));
}

export async function includeManagement(graph: ResourceGraph): Promise<void> {
  await loadPublicationManagement(graph);
  await hashGraph(graph);
}

export async function gltfBuffers(graph: ResourceGraph, path: string, json: JSONObject): Promise<Buffer[]> {
  let binary: Buffer | undefined;
  if (path.toLowerCase().endsWith(".glb")) binary = parseGLB(await readFile(await resolveExistingSafe(graph.root, path)), path).binary;
  return Promise.all((json.buffers ?? []).map(async (buffer: JSONObject, index: number) => {
    let bytes: Buffer;
    if (typeof buffer.uri === "string") {
      bytes = buffer.uri.startsWith("data:") ? dataURI(buffer.uri) : await readFile(await resolveExistingSafe(graph.root, resourcePath(path, buffer.uri)));
    } else if (index === 0 && binary) bytes = binary;
    else if (buffer.extensions?.EXT_meshopt_compression?.fallback === true) return Buffer.alloc(0);
    else throw new Error(`missing buffer data in ${path} buffer ${index}`);
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || bytes.length < buffer.byteLength) throw new Error(`invalid buffer length in ${path}`);
    return bytes.subarray(0, buffer.byteLength);
  }));
}

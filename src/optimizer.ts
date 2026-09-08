import { readFile, stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import { Logger } from "@gltf-transform/core";
import { assertDifferentRoots, commitDirectory, copyFileChecked, createTemporarySibling, ensureDirectoryEmpty, pathExists, readJSON, removeIfExists, resolveExistingSafe, sha256Buffer, sha256File, writeAtomic, writeJSONAtomic } from "./fs-utils.js";
import { dataURI, gltfBuffers, includeManagement, loadResourceGraph, relativeURI, resourcePath, visitURIs, type JSONObject, type ResourceGraph } from "./resource-graph.js";
import { encodeKTX2, findBasisuBinary, type TextureUsage } from "./texture-codec.js";
import { createDecodeIO } from "./glb.js";
import type { OptimizationCLIOptions } from "./types.js";
import { validateFeatureMetadata, type FeatureValidation } from "./features.js";

export const OPTIMIZER_VERSION = "0.3.0";
export const OPTIMIZATION_PROFILE = "web-v1" as const;
interface BufferPlan { source: string; parts: Buffer[]; size: number; ranges: Map<string, { offset: number; length: number }>; path: string }
interface AssetResult { source: string; path: string; json: JSONObject; plans: BufferPlan[] }
export interface OptimizationReport {
  schema: "model-optimizer.optimization-report"; version: 3; status: "succeeded" | "failed";
  profile: "web-v1"; inputRoot: string; outputRoot: string; inputSceneHash: string; outputSceneHash?: string;
  releaseId: string; startedAt: string; finishedAt?: string; errors?: string[];
  assets: Array<{ prototypeId: string; level: number; path: string; sourceBytes: number; outputBytes: number; sourceSha256: string; outputSha256: string }>;
  geometryResources: number; textureResources: number; compressedViews: number;
  inputBytes: number; outputBytes: number;
  featureValidation?: FeatureValidation;
  preservedExtensions?: string[];
}

export async function runOptimizer(options: OptimizationCLIOptions): Promise<OptimizationReport> {
  const inputRoot = resolve(options.input), outputRoot = resolve(options.output);
  assertDifferentRoots(inputRoot, outputRoot);
  if (!(await stat(inputRoot)).isDirectory()) throw new Error("optimize a tileset directory, then use runtime assembly to publish SQLite");
  if (await pathExists(join(inputRoot, "lod-manifest.json"))) throw new Error("staged LOD assets must be integrated by runtime assembly before optimization");
  if (await pathExists(join(inputRoot, "optimization-manifest.json"))) throw new Error("input is already optimized; use the original build or publication");
  const graph = await loadResourceGraph(inputRoot);
  await includeManagement(graph);
  const releaseId = (await sha256Buffer(Buffer.from(`${graph.hash}\n${OPTIMIZER_VERSION}\nmeshoptimizer@1.2.0\nbasisu@1.16.3\n${OPTIMIZATION_PROFILE}`))).slice(0, 32);
  await ensureDirectoryEmpty(outputRoot);
  if (await pathExists(outputRoot)) await removeIfExists(outputRoot);
  const workRoot = await createTemporarySibling(outputRoot);
  const report: OptimizationReport = { schema: "model-optimizer.optimization-report", version: 3, status: "failed", profile: OPTIMIZATION_PROFILE, inputRoot, outputRoot, inputSceneHash: graph.hash, releaseId, startedAt: new Date().toISOString(), assets: [], geometryResources: 0, textureResources: 0, compressedViews: 0, inputBytes: [...graph.files.values()].reduce((sum, file) => sum + file.bytes, 0), outputBytes: 0 };
  const pathMap = new Map<string, string>();
  for (const path of graph.files.keys()) pathMap.set(path, path
    .replace(/^releases\/[^/]+\//, `releases/${releaseId}/`)
    .replace(/^resources\/scenes\//, `resources/scenes/${releaseId}/`));
  for (const path of graph.gltfs) if (path.endsWith(".glb")) pathMap.set(path, `${pathMap.get(path)!}.gltf`);
  const plans = new Map<string, BufferPlan>();
  const textureCache = new Map<string, { path: string; bytes: Buffer }>();
  let basisu: string | undefined;
  const getTexture = async (image: Buffer, usage: TextureUsage, name: string): Promise<string> => {
    const key = await sha256Buffer(Buffer.concat([image, Buffer.from(`\n${usage}\n${OPTIMIZATION_PROFILE}\nbasisu@1.16.3`)]));
    let cached = textureCache.get(key);
    if (!cached) {
      const isKTX2 = image.subarray(0, 12).toString("hex") === "ab4b5458203230bb0d0a1a0a";
      const bytes = isKTX2 ? image : await encodeKTX2(image, usage, basisu ??= await findBasisuBinary());
      cached = { path: `resources/textures/${safeName(name)}/${key}.ktx2`, bytes };
      textureCache.set(key, cached);
    }
    return cached.path;
  };
  try {
    if (new Set(pathMap.values()).size !== pathMap.size) throw new Error("optimized content path collision");
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    const results: AssetResult[] = [];
    for (const source of [...graph.gltfs].sort()) {
      const json = structuredClone(graph.documents.get(source)!);
      const buffers = await gltfBuffers(graph, source, json);
      const sourceHashes = await Promise.all(buffers.map(sha256Buffer));
      const path = pathMap.get(source)!;
      const originalImageViews = new Set<number>((json.images ?? []).map((image: JSONObject) => image.bufferView).filter(Number.isInteger));
      await optimizeTextures(graph, source, path, json, buffers, getTexture, pathMap);
      const retainedViews = referencedViews(json);
      const localPlans: BufferPlan[] = [], newBuffers: JSONObject[] = [];
      const bufferIndex = (plan: BufferPlan): number => {
        let index = localPlans.indexOf(plan);
        if (index < 0) { index = localPlans.length; localPlans.push(plan); newBuffers.push({}); }
        return index;
      };
      const fallback: JSONObject = { byteLength: 0, extensions: { EXT_meshopt_compression: { fallback: true } } };
      let compressedViews = 0;
      for (let index = 0; index < (json.bufferViews ?? []).length; index++) {
        const view = json.bufferViews[index] as JSONObject;
        const sourceBuffer = json.buffers[view.buffer] as JSONObject | undefined;
        if (!sourceBuffer) throw new Error(`invalid bufferView buffer in ${source}`);
        const sourceName = typeof sourceBuffer.uri === "string" && !sourceBuffer.uri.startsWith("data:") ? resourcePath(source, sourceBuffer.uri) : `${source}/buffer-${view.buffer}`;
        const raw = originalImageViews.has(index) && !retainedViews.has(index) ? Buffer.alloc(4) : readView(view, buffers, source);
        const layout = compressionLayout(json, index, view, raw.length);
        const key = await sha256Buffer(Buffer.concat([raw, Buffer.from(JSON.stringify({ layout, accessors: (json.accessors ?? []).filter((a: JSONObject) => a.bufferView === index).map((a: JSONObject) => ({ ...a, bufferView: 0 })) }))]));
        const planKey = `${sourceName}\n${sourceHashes[view.buffer]}`;
        let plan = plans.get(planKey);
        if (!plan) { plan = { source: sourceName, parts: [], size: 0, ranges: new Map(), path: "" }; plans.set(planKey, plan); }
        let range = plan.ranges.get(key);
        if (!range) {
          let encoded = raw;
          if (layout) {
            encoded = Buffer.from(MeshoptEncoder.encodeGltfBuffer(raw, layout.count, layout.stride, layout.mode));
            const decoded = Buffer.alloc(raw.length);
            MeshoptDecoder.decodeGltfBuffer(decoded, layout.count, layout.stride, encoded, layout.mode);
            if (!decoded.equals(raw)) throw new Error(`Meshopt lossless verification failed: ${source} bufferView ${index}`);
          }
          const padding = (4 - plan.size % 4) % 4;
          if (padding) { plan.parts.push(Buffer.alloc(padding)); plan.size += padding; }
          range = { offset: plan.size, length: encoded.length };
          plan.parts.push(encoded); plan.size += encoded.length; plan.ranges.set(key, range);
        }
        const targetBuffer = bufferIndex(plan);
        if (layout) {
          fallback.byteLength += (4 - fallback.byteLength % 4) % 4;
          view.buffer = -1; view.byteOffset = fallback.byteLength;
          fallback.byteLength += raw.length;
          view.extensions = { ...view.extensions, EXT_meshopt_compression: { buffer: targetBuffer, byteOffset: range.offset, byteLength: range.length, byteStride: layout.stride, count: layout.count, mode: layout.mode } };
          compressedViews++;
        } else {
          view.buffer = targetBuffer; view.byteOffset = range.offset; view.byteLength = range.length;
          if (view.extensions) { delete view.extensions.EXT_meshopt_compression; if (!Object.keys(view.extensions).length) delete view.extensions; }
        }
      }
      if (compressedViews) {
        const fallbackIndex = newBuffers.length; newBuffers.push(fallback);
        for (const view of json.bufferViews) if (view.buffer === -1) view.buffer = fallbackIndex;
        requireExtension(json, "EXT_meshopt_compression");
      }
      if (newBuffers.length) json.buffers = newBuffers; else delete json.buffers;
      report.compressedViews += compressedViews;
      results.push({ source, path, json, plans: localPlans });
    }
    for (const plan of plans.values()) {
      const bytes = Buffer.concat(plan.parts), hash = await sha256Buffer(bytes);
      plan.path = `resources/buffers/${safeName(posix.basename(plan.source))}/${hash}.bin`;
      await writeAtomic(join(workRoot, plan.path), bytes); plan.parts = [];
    }
    for (const texture of textureCache.values()) await writeAtomic(join(workRoot, texture.path), texture.bytes);
    const generated = new Set<string>();
    for (const result of results) {
      result.plans.forEach((plan, index) => { result.json.buffers[index] = { uri: relativeURI(result.path, plan.path), byteLength: plan.size }; });
      visitURIs(result.json, (object, key, uri) => {
        if (uri.startsWith("data:") || key === "uri" && (result.json.buffers?.includes(object) || result.json.images?.includes(object))) return;
        const old = resourcePath(result.source, uri);
        if (pathMap.has(old)) object[key] = relativeURI(result.path, pathMap.get(old)!);
      });
      await writeJSONAtomic(join(workRoot, result.path), result.json); generated.add(result.path);
      report.assets.push({ prototypeId: result.source, level: 0, path: result.path, sourceBytes: graph.files.get(result.source)!.bytes, outputBytes: (await stat(join(workRoot, result.path))).size, sourceSha256: graph.files.get(result.source)!.sha256, outputSha256: await sha256File(join(workRoot, result.path)) });
    }
    for (const [source, target] of pathMap) {
      if (generated.has(target)) continue;
      const json = graph.documents.get(source);
      if (json) {
        const output = structuredClone(json);
        visitURIs(output, (object, key, uri) => { if (!uri.startsWith("data:")) object[key] = relativeURI(target, pathMap.get(resourcePath(source, uri))!); });
        if (output.asset?.extras) rewriteExtras(output.asset.extras, pathMap, releaseId);
        await writeJSONAtomic(join(workRoot, target), output);
      } else await copyFileChecked(await resolveExistingSafe(inputRoot, source), join(workRoot, target));
    }
    const outputGraph = await loadResourceGraph(workRoot);
    for (const target of pathMap.values()) if (!outputGraph.files.has(target)) await removeIfExists(join(workRoot, target));
    await copyManagement(graph, workRoot, pathMap, releaseId);
    await includeManagement(outputGraph);
    report.featureValidation = await validateFeatureMetadata(outputGraph);
    const io = await createDecodeIO();
    let preservedInstanceFeatures = 0;
    const logger = Logger.DEFAULT_INSTANCE;
    io.setLogger({
      debug: text => logger.debug(text), info: text => logger.info(text), error: text => logger.error(text),
      warn: text => {
        if (text === 'Missing optional extension, "EXT_instance_features".') preservedInstanceFeatures++;
        else logger.warn(text);
      }
    });
    for (const path of outputGraph.gltfs) { const document = await io.read(join(workRoot, path)); document.getRoot().dispose(); }
    if (preservedInstanceFeatures) report.preservedExtensions = ["EXT_instance_features"];
    report.geometryResources = plans.size; report.textureResources = textureCache.size;
    report.outputBytes = [...outputGraph.files.values()].reduce((sum, file) => sum + file.bytes, 0);
    report.outputSceneHash = outputGraph.hash; report.status = "succeeded"; report.finishedAt = new Date().toISOString();
    await writeJSONAtomic(join(workRoot, "optimization-manifest.json"), { schema: "model-optimizer.optimization-manifest", version: 3, profile: OPTIMIZATION_PROFILE, stage: "publication", inputHash: graph.hash, outputHash: outputGraph.hash, releaseId, assets: report.assets, toolchain: { version: OPTIMIZER_VERSION, meshoptimizer: "1.2.0", gltfTransform: "4.5.0", basisu: "1.16.3" } });
    await writeJSONAtomic(join(workRoot, "optimization-report.json"), report);
    await commitDirectory(workRoot, outputRoot);
    return report;
  } catch (error) {
    report.errors = [error instanceof Error ? error.message : String(error)]; await removeIfExists(workRoot);
    throw Object.assign(new Error(report.errors[0]), { report });
  }
}

function safeName(value: string): string { return value.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "asset"; }
function requireExtension(json: JSONObject, name: string): void { for (const key of ["extensionsUsed", "extensionsRequired"]) json[key] = [...new Set([...(json[key] ?? []), name])]; }
const TEXTURE_CODECS = ["KHR_texture_basisu", "EXT_texture_webp", "EXT_texture_avif", "MSFT_texture_dds"];

function referencedViews(json: JSONObject): Set<number> {
  const result = new Set<number>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "extras") continue;
      if (key === "bufferView" && Number.isInteger(entry)) result.add(entry as number);
      else walk(entry);
    }
  };
  walk(json);
  for (const table of json.extensions?.EXT_structural_metadata?.propertyTables ?? []) {
    for (const property of Object.values(table.properties ?? {}) as JSONObject[]) {
      for (const key of ["values", "arrayOffsets", "stringOffsets"]) if (Number.isInteger(property[key])) result.add(property[key]);
    }
  }
  return result;
}

function readView(view: JSONObject, buffers: Buffer[], label: string): Buffer {
  const compression = view.extensions?.EXT_meshopt_compression;
  if (compression) {
    const source = buffers[compression.buffer], start = compression.byteOffset ?? 0;
    if (!source || start < 0 || start + compression.byteLength > source.length) throw new Error(`invalid compressed bufferView in ${label}`);
    const bytes = Buffer.alloc(compression.count * compression.byteStride);
    MeshoptDecoder.decodeGltfBuffer(bytes, compression.count, compression.byteStride, source.subarray(start, start + compression.byteLength), compression.mode, compression.filter);
    if (bytes.length !== view.byteLength) throw new Error(`compressed bufferView length mismatch in ${label}`);
    return bytes;
  }
  const source = buffers[view.buffer], start = view.byteOffset ?? 0;
  if (!source || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength <= 0 || start + view.byteLength > source.length) throw new Error(`invalid bufferView range in ${label}`);
  return source.subarray(start, start + view.byteLength);
}

function compressionLayout(json: JSONObject, index: number, view: JSONObject, bytes: number): { count: number; stride: number; mode: string } | undefined {
  const accessors = (json.accessors ?? []).filter((a: JSONObject) => a.bufferView === index);
  if (!accessors.length) return undefined;
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let stride = view.byteStride;
  if (!stride) { const layouts = new Set(accessors.map((a: JSONObject) => (components[a.type] ?? 0) * (sizes[a.componentType] ?? 0))); if (layouts.size !== 1) return undefined; stride = [...layouts][0]; }
  const isIndex = (json.meshes ?? []).some((mesh: JSONObject) => mesh.primitives?.some((p: JSONObject) => p.indices !== undefined && json.accessors[p.indices]?.bufferView === index));
  if (isIndex ? ![2, 4].includes(stride) : !stride || stride % 4 || stride > 256) return undefined;
  if (bytes % stride) return undefined;
  return { count: bytes / stride, stride, mode: isIndex ? "INDICES" : "ATTRIBUTES" };
}

async function optimizeTextures(graph: ResourceGraph, source: string, target: string, json: JSONObject, buffers: Buffer[], getTexture: (image: Buffer, usage: TextureUsage, name: string) => Promise<string>, paths: Map<string, string>): Promise<void> {
  const textures = json.textures ?? [], images = json.images ?? [];
  const protectedTextures = json.extensions?.EXT_structural_metadata?.propertyTextures?.length || (json.meshes ?? []).some((m: JSONObject) => m.primitives?.some((p: JSONObject) => p.extensions?.EXT_mesh_features?.featureIds?.some((f: JSONObject) => f.texture)));
  const variants = new Map<string, number>(), outputTextures: JSONObject[] = protectedTextures ? structuredClone(textures) : [], outputImages: JSONObject[] = protectedTextures ? structuredClone(images) : [];
  for (const image of outputImages) if (typeof image.uri === "string" && !image.uri.startsWith("data:")) image.uri = relativeURI(target, paths.get(resourcePath(source, image.uri))!);
  const convert = async (index: number, usage: TextureUsage): Promise<number> => {
    const key = `${index}:${usage}`; if (variants.has(key)) return variants.get(key)!;
    const texture = textures[index]; if (!texture) throw new Error(`invalid texture index in ${source}`);
    const image = images[texture.extensions?.KHR_texture_basisu?.source ?? texture.extensions?.EXT_texture_webp?.source ?? texture.extensions?.EXT_texture_avif?.source ?? texture.source]; if (!image) throw new Error(`invalid image index in ${source}`);
    let bytes: Buffer;
    if (typeof image.uri === "string") bytes = image.uri.startsWith("data:") ? dataURI(image.uri) : await readFile(await resolveExistingSafe(graph.root, resourcePath(source, image.uri)));
    else if (Number.isInteger(image.bufferView)) bytes = readView(json.bufferViews[image.bufferView], buffers, source);
    else throw new Error(`missing image data in ${source}`);
    const path = await getTexture(bytes, usage, image.name || posix.basename(image.uri || source));
    const newImage = outputImages.length; outputImages.push({ ...image, uri: relativeURI(target, path), mimeType: "image/ktx2" }); delete outputImages[newImage]!.bufferView;
    const extensions = { ...texture.extensions };
    for (const codec of TEXTURE_CODECS) delete extensions[codec];
    const newTexture = { ...texture, extensions: { ...extensions, KHR_texture_basisu: { source: newImage } } }; delete newTexture.source;
    const outputIndex = outputTextures.length; outputTextures.push(newTexture); variants.set(key, outputIndex); return outputIndex;
  };
  const walk = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) await walk(entry); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "extras") continue;
      if (/Texture$/.test(key) && entry && typeof entry === "object" && Number.isInteger((entry as JSONObject).index)) {
        const usage: TextureUsage = /normal/i.test(key) ? "normal" : /baseColor|emissive|diffuse|specularColor|sheenColor/i.test(key) ? "color" : "data";
        (entry as JSONObject).index = await convert((entry as JSONObject).index, usage);
      } else await walk(entry);
    }
  };
  await walk(json.materials ?? []);
  if (outputTextures.length) { json.textures = outputTextures; json.images = outputImages; if (variants.size) requireExtension(json, "KHR_texture_basisu"); }
  else for (const image of images) if (typeof image.uri === "string" && !image.uri.startsWith("data:")) image.uri = relativeURI(target, paths.get(resourcePath(source, image.uri))!);
  for (const codec of TEXTURE_CODECS) {
    if ((json.textures ?? []).some((texture: JSONObject) => texture.extensions?.[codec])) continue;
    for (const key of ["extensionsUsed", "extensionsRequired"]) {
      if (!Array.isArray(json[key])) continue;
      json[key] = json[key].filter((extension: string) => extension !== codec);
      if (!json[key].length) delete json[key];
    }
  }
}

function rewriteExtras(extras: JSONObject, paths: Map<string, string>, releaseId: string): void {
  for (const key of ["objectIndex", "catalog"]) if (typeof extras[key] === "string") extras[key] = paths.get(extras[key]) ?? extras[key].replace(/^releases\/[^/]+\//, `releases/${releaseId}/`);
  if (extras.releaseId) extras.releaseId = releaseId;
}

async function copyManagement(graph: ResourceGraph, output: string, paths: Map<string, string>, releaseId: string): Promise<void> {
  const catalogPaths = new Set<string>();
  for (const json of graph.documents.values()) if (typeof json.asset?.extras?.catalog === "string") catalogPaths.add(json.asset.extras.catalog);
  if (await pathExists(join(graph.root, "_pack/catalog.json"))) catalogPaths.add("_pack/catalog.json");
  for (const source of catalogPaths) {
    const catalog = await readJSON<JSONObject>(await resolveExistingSafe(graph.root, source));
    if (catalog.schema !== "model-optimizer.tileset-catalog" || catalog.version !== 1) throw new Error(`unsupported publication catalog: ${source}`);
    const rewrite = (path: string): string => paths.get(path) ?? path.replace(/^releases\/[^/]+\//, `releases/${releaseId}/`);
    const objectSource = catalog.objectIndex;
    const objectIndex = await readJSON<JSONObject>(await resolveExistingSafe(graph.root, objectSource));
    for (const object of objectIndex.objects ?? []) {
      object.contents = (object.contents ?? []).map((path: string) => {
        if (!paths.has(path)) throw new Error(`object content not reachable from tileset: ${path}`);
        return rewrite(path);
      });
    }
    catalog.root = rewrite(catalog.root); catalog.objectIndex = rewrite(objectSource);
    for (const node of catalog.nodes ?? []) node.payloadPath = rewrite(node.payloadPath);
    if (catalog.releaseId) catalog.releaseId = releaseId;
    await writeJSONAtomic(join(output, catalog.objectIndex), objectIndex);
    await writeJSONAtomic(join(output, rewrite(source)), catalog);
  }
}

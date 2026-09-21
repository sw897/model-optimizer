import { link, lstat, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import { Logger } from "@gltf-transform/core";
import { assertDifferentRoots, commitDirectory, copyFileChecked, createTemporarySibling, ensureDirectoryEmpty, pathExists, removeIfExists, resolveExistingSafe, sha256Buffer, sha256File, writeAtomic, writeJSONAtomic } from "./fs-utils.js";
import { dataURI, gltfBuffers, hashGraph, includeManagement, loadGLTFResourceGraph, loadResourceGraph, relativeURI, resourcePath, visitURIs, type JSONObject, type ResourceGraph } from "./resource-graph.js";
import { encodeKTX2, findBasisuBinary, type TextureUsage } from "./texture-codec.js";
import { createDecodeIO } from "./glb.js";
import type { OptimizationCLIOptions, OptimizationInputKind } from "./types.js";
import { validateFeatureMetadata, type FeatureValidation } from "./features.js";
import { packGLB } from "./glb-container.js";
import { rewritePublicationManagement } from "./publication-index.js";

export const OPTIMIZER_VERSION = "0.3.2";
export const OPTIMIZATION_PROFILE = "web-v1" as const;
interface BufferPlan { parts: Buffer[]; size: number; ranges: Map<string, { offset: number; length: number }>; path: string }
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
  inputKind: OptimizationInputKind;
}

export async function runOptimizer(options: OptimizationCLIOptions): Promise<OptimizationReport> {
  const inputRoot = resolve(options.input), outputRoot = resolve(options.output);
  assertDifferentRoots(inputRoot, outputRoot);
  const input = await loadOptimizationInput(inputRoot);
  const { graph, kind } = input;
  if (kind === "glb-file") {
    if (extname(outputRoot).toLowerCase() !== ".glb") throw new Error("single GLB output must be a .glb file");
    if (await lstat(outputRoot).catch(missingEntry)) throw new Error(`output file already exists: ${outputRoot}`);
  } else {
    assertDifferentRoots(outputRoot, inputRoot);
    const output = await lstat(outputRoot).catch(missingEntry);
    if (output?.isSymbolicLink()) throw new Error("output directory must not be a symlink");
    await ensureDirectoryEmpty(outputRoot);
    if (output) await removeIfExists(outputRoot);
  }
  const releaseId = (await sha256Buffer(Buffer.from(`${graph.hash}\n${OPTIMIZER_VERSION}\nmeshoptimizer@1.2.0\nbasisu@1.16.3\n${OPTIMIZATION_PROFILE}`))).slice(0, 32);
  const workRoot = await createTemporarySibling(outputRoot);
  const report: OptimizationReport = { schema: "model-optimizer.optimization-report", version: 3, status: "failed", profile: OPTIMIZATION_PROFILE, inputKind: kind, inputRoot, outputRoot, inputSceneHash: graph.hash, releaseId, startedAt: new Date().toISOString(), assets: [], geometryResources: 0, textureResources: 0, compressedViews: 0, inputBytes: [...graph.files.values()].reduce((sum, file) => sum + file.bytes, 0), outputBytes: 0 };
  const pathMap = new Map<string, string>();
  for (const path of input.resources) pathMap.set(path, kind === "tileset" ? path
    .replace(/^releases\/[^/]+\//, `releases/${releaseId}/`)
    .replace(/^resources\/scenes\//, `resources/scenes/${releaseId}/`) : path);
  for (const path of graph.gltfs) if (path.toLowerCase().endsWith(".glb")) pathMap.set(path, `${pathMap.get(path)!}.gltf`);
  try {
    const optimized = await optimizeResourceGraph(graph, kind === "tileset" ? workRoot : join(workRoot, "graph"), pathMap, report, input.entries);
    const output = kind === "tileset" ? optimized : await finalizeGLBs(input, optimized, join(workRoot, "output"), pathMap, report);
    report.featureValidation = await validateOptimizedGraph(output, report);
    report.outputBytes = [...output.files.values()].reduce((sum, file) => sum + file.bytes, 0);
    report.outputSceneHash = output.hash; report.status = "succeeded"; report.finishedAt = new Date().toISOString();
    if (kind === "glb-file") {
      await link(join(output.root, report.assets[0]!.path), outputRoot);
      await removeIfExists(workRoot);
    } else {
      await writeJSONAtomic(join(output.root, "optimization-manifest.json"), { schema: "model-optimizer.optimization-manifest", version: 3, profile: OPTIMIZATION_PROFILE, stage: "publication", inputKind: kind, inputHash: graph.hash, outputHash: output.hash, releaseId, assets: report.assets, toolchain: { version: OPTIMIZER_VERSION, meshoptimizer: "1.2.0", gltfTransform: "4.5.0", basisu: "1.16.3" } });
      await writeJSONAtomic(join(output.root, "optimization-report.json"), report);
      await commitDirectory(output.root, outputRoot);
      if (kind !== "tileset") await removeIfExists(workRoot);
    }
    return report;
  } catch (error) {
    report.status = "failed"; report.finishedAt = new Date().toISOString();
    report.errors = [error instanceof Error ? error.message : String(error)]; await removeIfExists(workRoot);
    throw Object.assign(new Error(report.errors[0]), { report });
  }
}

interface OptimizationInput { kind: OptimizationInputKind; graph: ResourceGraph; entries: string[]; resources: string[]; auxiliary: string[]; directories: string[] }

function missingEntry(error: NodeJS.ErrnoException): undefined {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}

async function loadOptimizationInput(input: string): Promise<OptimizationInput> {
  const info = await lstat(input);
  if (info.isSymbolicLink()) throw new Error("input must not be a symlink");
  if (info.isFile()) {
    if (extname(input).toLowerCase() !== ".glb") throw new Error("single model input must be a GLB file");
    const entries = [basename(input)], graph = await loadGLTFResourceGraph(dirname(input), entries);
    assertUnoptimizedModels(graph);
    return { kind: "glb-file", graph, entries, resources: [...graph.files.keys()], auxiliary: [], directories: [] };
  }
  if (!info.isDirectory()) throw new Error("input must be a GLB file or model directory");
  if (await pathExists(join(input, "lod-manifest.json"))) throw new Error("staged LOD assets must be integrated by runtime assembly before optimization");
  if (await pathExists(join(input, "optimization-manifest.json"))) throw new Error("input is already optimized; use the original build or publication");
  if (await pathExists(join(input, "tileset.json"))) {
    const graph = await loadResourceGraph(input); await includeManagement(graph); assertUnoptimizedModels(graph, false);
    return { kind: "tileset", graph, entries: ["tileset.json"], resources: [...graph.files.keys()], auxiliary: [], directories: [] };
  }
  if (await pathExists(join(input, "optimization-report.json"))) throw new Error("input contains a reserved optimization report");
  const files: string[] = [], directories: string[] = [];
  const scan = async (parent: string): Promise<void> => {
    for (const file of await readdir(join(input, parent), { withFileTypes: true })) {
      const path = posix.join(parent, file.name);
      if (file.isSymbolicLink()) throw new Error(`model directory contains a symlink: ${path}`);
      if (file.isDirectory()) { directories.push(path); await scan(path); }
      else if (file.isFile()) files.push(path);
      else throw new Error(`model directory contains a non-regular file: ${path}`);
    }
  };
  await scan("");
  const entries = files.filter(path => path.toLowerCase().endsWith(".glb")).sort();
  if (!entries.length) throw new Error("model directory contains no GLB files or tileset.json");
  const graph = await loadGLTFResourceGraph(input, entries);
  assertUnoptimizedModels(graph);
  const resources = [...graph.files.keys()];
  const auxiliary = files.filter(path => !entries.includes(path));
  await includeFiles(graph, auxiliary);
  return { kind: "glb-directory", graph, entries, resources, auxiliary, directories };
}

function assertUnoptimizedModels(graph: ResourceGraph, markable = true): void {
  for (const name of graph.gltfs) {
    const extras = graph.documents.get(name)!.asset.extras;
    if (markable && extras != null && (typeof extras !== "object" || Array.isArray(extras))) throw new Error(`asset.extras must be an object to mark optimized model: ${name}`);
    if (extras && Object.hasOwn(extras, "modelOptimizer")) throw new Error(`model is already optimized or asset.extras.modelOptimizer is reserved: ${name}`);
  }
}

async function includeFiles(graph: ResourceGraph, files: string[]): Promise<void> {
  for (const path of files) {
    if (graph.files.has(path)) continue;
    const absolute = await resolveExistingSafe(graph.root, path);
    graph.files.set(path, { sha256: await sha256File(absolute), bytes: (await stat(absolute)).size });
  }
  await hashGraph(graph);
}

async function finalizeGLBs(input: OptimizationInput, optimized: ResourceGraph, root: string, paths: Map<string, string>, report: OptimizationReport): Promise<ResourceGraph> {
  const entries: string[] = [];
  report.assets = [];
  for (const directory of input.directories) await mkdir(join(root, directory), { recursive: true });
  for (const source of input.entries) {
    const path = paths.get(source)!, json = optimized.documents.get(path)!;
    json.asset.extras = { ...json.asset.extras, modelOptimizer: { schema: "model-optimizer.asset-metadata", version: 1, profile: OPTIMIZATION_PROFILE, toolVersion: OPTIMIZER_VERSION, sourceSha256: input.graph.files.get(source)!.sha256 } };
    const bytes = await packGLB(optimized, path);
    const target = input.kind === "glb-file" ? basename(report.outputRoot) : source;
    await writeAtomic(join(root, target), bytes); entries.push(target);
    report.assets.push({ prototypeId: source, level: 0, path: target, sourceBytes: input.graph.files.get(source)!.bytes, outputBytes: bytes.length, sourceSha256: input.graph.files.get(source)!.sha256, outputSha256: await sha256Buffer(bytes) });
  }
  for (const source of input.auxiliary) await copyFileChecked(await resolveExistingSafe(input.graph.root, source), join(root, source));
  for (const [path, file] of input.graph.files) if (await sha256File(await resolveExistingSafe(input.graph.root, path)) !== file.sha256) throw new Error(`input changed during optimization: ${path}`);
  const graph = await loadGLTFResourceGraph(root, entries);
  await includeFiles(graph, input.auxiliary);
  return graph;
}

async function optimizeResourceGraph(graph: ResourceGraph, workRoot: string, pathMap: Map<string, string>, report: OptimizationReport, entries: string[]): Promise<ResourceGraph> {
  const inputRoot = graph.root, { releaseId } = report;
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
  if (new Set(pathMap.values()).size !== pathMap.size) throw new Error("optimized content path collision");
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const results: AssetResult[] = [];
  for (const source of [...graph.gltfs].sort()) {
    const json = structuredClone(graph.documents.get(source)!);
    const buffers = await gltfBuffers(graph, source, json);
    const sourceHashes = await Promise.all(buffers.map(sha256Buffer));
    const accessorsByView = new Map<number, JSONObject[]>();
    for (const accessor of json.accessors ?? []) {
      if (!Number.isInteger(accessor.bufferView)) continue;
      const list = accessorsByView.get(accessor.bufferView) ?? [];
      list.push(accessor); accessorsByView.set(accessor.bufferView, list);
    }
    const indexViews = new Set<number>();
    for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
      const view = json.accessors?.[primitive.indices]?.bufferView;
      if (Number.isInteger(view)) indexViews.add(view);
    }
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
    const fallbackRanges = new Map<string, number>();
    let compressedViews = 0;
    for (let index = 0; index < (json.bufferViews ?? []).length; index++) {
      const view = json.bufferViews[index] as JSONObject;
      const sourceBuffer = json.buffers[view.buffer] as JSONObject | undefined;
      if (!sourceBuffer) throw new Error(`invalid bufferView buffer in ${source}`);
      const raw = originalImageViews.has(index) && !retainedViews.has(index) ? Buffer.alloc(4) : readView(view, buffers, source);
      const layout = compressionLayout(accessorsByView.get(index) ?? [], indexViews.has(index), view, raw.length);
      const key = createHash("sha256").update(raw).update(JSON.stringify(layout) ?? "raw").digest("hex");
      const sourceIndex = view.extensions?.EXT_meshopt_compression?.buffer ?? view.buffer;
      const planKey = sourceHashes[sourceIndex];
      if (!planKey) throw new Error(`invalid bufferView source in ${source}`);
      let plan = plans.get(planKey);
      if (!plan) { plan = { parts: [], size: 0, ranges: new Map(), path: "" }; plans.set(planKey, plan); }
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
        const fallbackKey = `${targetBuffer}:${key}`;
        let offset = fallbackRanges.get(fallbackKey);
        if (offset === undefined) {
          fallback.byteLength += (4 - fallback.byteLength % 4) % 4;
          offset = Number(fallback.byteLength); fallback.byteLength += raw.length;
          fallbackRanges.set(fallbackKey, offset);
        }
        view.buffer = -1; view.byteOffset = offset;
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
    plan.path = `resources/buffers/${hash}.bin`;
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
    await writeJSONAtomic(join(workRoot, result.path), result.json, true); generated.add(result.path);
    report.assets.push({ prototypeId: result.source, level: 0, path: result.path, sourceBytes: graph.files.get(result.source)!.bytes, outputBytes: (await stat(join(workRoot, result.path))).size, sourceSha256: graph.files.get(result.source)!.sha256, outputSha256: await sha256File(join(workRoot, result.path)) });
  }
  for (const [source, target] of pathMap) {
    if (generated.has(target)) continue;
    const json = graph.documents.get(source);
    if (json) {
      const output = structuredClone(json);
      visitURIs(output, (object, key, uri) => { if (!uri.startsWith("data:")) object[key] = relativeURI(target, pathMap.get(resourcePath(source, uri))!); });
      if (output.asset?.extras) rewriteExtras(output.asset.extras, pathMap, releaseId);
      await writeJSONAtomic(join(workRoot, target), output, true);
    } else await copyFileChecked(await resolveExistingSafe(inputRoot, source), join(workRoot, target));
  }
  let outputGraph = report.inputKind === "tileset" ? await loadResourceGraph(workRoot) : await loadGLTFResourceGraph(workRoot, entries.map(path => pathMap.get(path)!));
  for (const target of pathMap.values()) if (!outputGraph.files.has(target)) await removeIfExists(join(workRoot, target));
  if (report.inputKind === "tileset") {
    await rewritePublicationManagement(graph, workRoot, pathMap, releaseId);
    outputGraph = await loadResourceGraph(workRoot);
    await includeManagement(outputGraph);
  }
  for (const [path, file] of graph.files) if (await sha256File(await resolveExistingSafe(inputRoot, path)) !== file.sha256) throw new Error(`input changed during optimization: ${path}`);
  report.geometryResources = new Set([...plans.values()].map(plan => plan.path)).size; report.textureResources = textureCache.size;
  return outputGraph;
}

async function validateOptimizedGraph(outputGraph: ResourceGraph, report: OptimizationReport): Promise<FeatureValidation> {
  const features = await validateFeatureMetadata(outputGraph);
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
  for (const path of outputGraph.gltfs) { const document = await io.read(join(outputGraph.root, path)); document.getRoot().dispose(); }
  if (preservedInstanceFeatures) report.preservedExtensions = ["EXT_instance_features"];
  return features;
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

function compressionLayout(accessors: JSONObject[], isIndex: boolean, view: JSONObject, bytes: number): { count: number; stride: number; mode: string } | undefined {
  if (!accessors.length) return undefined;
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let stride = view.byteStride;
  if (!stride) { const layouts = new Set(accessors.map((a: JSONObject) => (components[a.type] ?? 0) * (sizes[a.componentType] ?? 0))); if (layouts.size !== 1) return undefined; stride = [...layouts][0]; }
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
  for (const key of ["objectIndex", "componentIndex", "catalog"]) if (typeof extras[key] === "string") extras[key] = paths.get(extras[key]) ?? extras[key].replace(/^releases\/[^/]+\//, `releases/${releaseId}/`);
  if (extras.releaseId) extras.releaseId = releaseId;
}

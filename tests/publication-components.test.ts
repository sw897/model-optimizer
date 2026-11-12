import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOptimizer } from "../src/optimizer.js";
import { includeManagement, loadGLTFResourceGraph, loadResourceGraph, type JSONObject } from "../src/resource-graph.js";
import { sha256File, writeAtomic, writeJSON } from "../src/fs-utils.js";
import { packGLB } from "../src/glb-container.js";
import { prototypeHasPartFeatures, simplifyGLB } from "../src/glb.js";
import { validateFeatureMetadata } from "../src/features.js";
import { rewritePublicationManagement } from "../src/publication-index.js";
import { runWorker } from "../src/worker.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const options = (input: string, output: string) => ({ input, output, json: false, verbose: false, help: false, version: false });
const bounds = { west: 100, south: 20, east: 101, north: 21, minHeight: 0, maxHeight: 1 };
const component = { sceneId: "line", objectId: "span/1", objectKey: "line/span/1", kind: "span", entityId: "1_L", entityType: "L", componentId: "1_L/1", componentType: "conductor", prototypeKey: "wire", displayName: "导线", sourceName: "1_L.obj" };

async function model(root: string, path: string, fields: Record<string, string>, part = false): Promise<void> {
  const parts = [Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer), Buffer.alloc(12)];
  const views: JSONObject[] = [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }];
  let size = 48;
  const properties: JSONObject = {}, definitions: JSONObject = {};
  for (const [name, value] of Object.entries(fields)) {
    const padding = (4 - size % 4) % 4; parts.push(Buffer.alloc(padding)); size += padding;
    const bytes = Buffer.from(value), offsets = Buffer.from(new Uint32Array([0, bytes.length]).buffer);
    const values = views.length; views.push({ buffer: 0, byteOffset: size, byteLength: bytes.length }); parts.push(bytes); size += bytes.length;
    const gap = (4 - size % 4) % 4; parts.push(Buffer.alloc(gap)); size += gap;
    const stringOffsets = views.length; views.push({ buffer: 0, byteOffset: size, byteLength: 8 }); parts.push(offsets); size += 8;
    properties[name] = { values, stringOffsets }; definitions[name] = { type: "STRING" };
  }
  const className = part ? "prototype_parts" : "model_components", attribute = part ? 1 : 0;
  const json = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    extensionsUsed: ["EXT_mesh_features", "EXT_structural_metadata"],
    buffers: [{ uri: "model.bin", byteLength: size }], bufferViews: views,
    accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3, min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, type: "SCALAR", count: 3 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, [`_FEATURE_ID_${attribute}`]: 1 }, extensions: { EXT_mesh_features: { featureIds: [{ attribute, propertyTable: 0, featureCount: 1 }] } } }] }],
    extensions: { EXT_structural_metadata: { schema: { id: "model_features_v2", classes: { [className]: { properties: definitions } } }, propertyTables: [{ class: className, count: 1, properties }] } },
  };
  await writeJSON(join(root, path), json);
  await writeFile(join(root, path.replace(/[^/]+$/, "model.bin")), Buffer.concat(parts));
}

async function fixture(packed = false): Promise<{ root: string; input: string; prefix: string; content: string; refresh: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "component-opt-")); roots.push(root);
  const input = join(root, "input"), releaseId = "a".repeat(32), prefix = packed ? `releases/${releaseId}/` : "";
  const content = "resources/scenes/original/wire.gltf";
  await model(input, content, component);
  await writeJSON(join(input, prefix + "objects/index.json"), { schema: "model-optimizer.tileset-objects", version: 1, objects: [{ sceneId: "line", objectId: "span/1", objectKey: "line/span/1", kind: "span", contents: [content], componentCount: 1 }] });
  await writeJSON(join(input, prefix + "components/shards/0.json"), { schema: "model-optimizer.tileset-component-shard", version: 1, components: [{ ...component, bounds, position: [100, 20, 0], contents: [{ path: content, level: 0 }] }] });
  const refresh = async (): Promise<void> => {
    const key = { objectKey: component.objectKey, componentId: component.componentId };
    await writeJSON(join(input, prefix + "components/index.json"), { schema: "model-optimizer.tileset-components", version: 1, count: 1, shards: [{ path: prefix + "components/shards/0.json", sha256: await sha256File(join(input, prefix + "components/shards/0.json")), count: 1, first: key, last: key, componentTypes: { conductor: 1 }, bounds }] });
    const catalog = { schema: "model-optimizer.tileset-catalog", version: 1, sceneId: "line", releaseId, root: prefix + "tileset.json", objectIndex: prefix + "objects/index.json", objectIndexSHA256: await sha256File(join(input, prefix + "objects/index.json")), componentIndex: prefix + "components/index.json", componentIndexSHA256: await sha256File(join(input, prefix + "components/index.json")), nodes: [{ sceneId: "line", payloadPath: prefix + "tileset.json", sourceHash: "source" }] };
    await writeJSON(join(input, prefix + "_pack/catalog.json"), catalog);
    const extras = { sceneId: "line", releaseId, catalog: prefix + "_pack/catalog.json", catalogSHA256: await sha256File(join(input, prefix + "_pack/catalog.json")), objectIndex: catalog.objectIndex, componentIndex: catalog.componentIndex };
    const tile = { asset: { version: "1.1", extras }, geometricError: 0, root: { boundingVolume: { region: [1, .3, 2, .4, 0, 1] }, geometricError: 0, content: { uri: (packed ? "../../" : "") + content } } };
    await writeJSON(join(input, prefix + "tileset.json"), tile);
    if (packed) { tile.root.content.uri = prefix + "tileset.json"; await writeJSON(join(input, "tileset.json"), tile); }
  };
  await refresh(); return { root, input, prefix, content, refresh };
}

describe("component publication integrity", () => {
  it.each([false, true])("enforces required identity fields in model_features_v2 (part=%s)", async part => {
    const root = await mkdtemp(join(tmpdir(), "feature-contract-")); roots.push(root);
    const fields: Record<string, string> = part ? { partId: "part-1", displayName: "Part", sourceName: "part.obj" } : { ...component };
    const missing = part ? "partId" : "componentId";
    delete fields[missing];
    await model(root, "model.gltf", fields, part);
    const graph = await loadGLTFResourceGraph(root, ["model.gltf"]);
    await expect(validateFeatureMetadata(graph)).rejects.toThrow(`missing model feature metadata ${missing}`);
  });

  it.each([false, true])("rewrites the hash chain and complete component references (packed=%s)", async packed => {
    const { root, input, content } = await fixture(packed), output = join(root, "web");
    const report = await runOptimizer(options(input, output));
    const graph = await loadResourceGraph(output); await includeManagement(graph);
    const extras = graph.documents.get("tileset.json")!.asset.extras;
    expect(extras.releaseId).toBe(report.releaseId);
    expect(extras.catalogSHA256).toBe(await sha256File(join(output, extras.catalog)));
    const catalog = graph.documents.get(extras.catalog)!;
    expect(catalog.componentIndexSHA256).toBe(await sha256File(join(output, catalog.componentIndex)));
    expect(catalog.objectIndexSHA256).toBe(await sha256File(join(output, catalog.objectIndex)));
    const index = graph.documents.get(catalog.componentIndex)!, shard = graph.documents.get(index.shards[0].path)!;
    const record = shard.components[0], target = content.replace("resources/scenes/", `resources/scenes/${report.releaseId}/`);
    expect(record).toMatchObject({ ...component, contents: [{ path: target, level: 0 }], bounds });
    expect(graph.gltfs.has(target)).toBe(true);
    expect(await validateFeatureMetadata(graph)).toMatchObject({ propertyRows: 1, featureSets: 1 });
    await expect(readFile(join(output, "_build/build-manifest.json"))).rejects.toThrow();
  });
  it.each(["catalog", "index", "shard", "metadata", "content"])("rejects %s corruption without publishing", async problem => {
    const { root, input, prefix, content, refresh } = await fixture();
    const output = join(root, "web");
    if (problem === "metadata") await model(input, content, { ...component, componentType: "jumper" });
    else if (problem === "content") {
      const path = join(input, prefix + "components/shards/0.json"), shard = JSON.parse(await readFile(path, "utf8"));
      shard.components[0].contents[0].path = "_build/unreachable.glb"; await writeJSON(path, shard); await refresh();
    } else await writeFile(join(input, prefix + ({ catalog: "_pack/catalog.json", index: "components/index.json", shard: "components/shards/0.json" } as const)[problem as "catalog" | "index" | "shard"]), "{}");
    await expect(runOptimizer(options(input, output))).rejects.toThrow(/hash mismatch|component index|not reachable/);
    await expect(readFile(join(output, "tileset.json"))).rejects.toThrow();
  });
  it("validates v2 traditional GLB metadata without scene fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "component-model-")); roots.push(root);
    const { sceneId: _scene, objectKey: _key, ...fields } = component;
    await model(root, "model.gltf", fields);
    const graph = await loadGLTFResourceGraph(root, ["model.gltf"]);
    await writeFile(join(root, "source.glb"), await packGLB(graph, "model.gltf"));
    const report = await runOptimizer(options(join(root, "source.glb"), join(root, "web.glb")));
    expect(report.featureValidation).toMatchObject({ featureSets: 1, propertyRows: 1 });
    await expect(prototypeHasPartFeatures(join(root, "source.glb"))).rejects.toThrow("not an assembled");
  });
  it("keeps part-feature prototypes base-only instead of dropping their metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "part-model-")); roots.push(root);
    await model(root, "model.gltf", { partId: "crossarm/1", displayName: "横担", sourceName: "crossarm.obj" }, true);
    const graph = await loadGLTFResourceGraph(root, ["model.gltf"]);
    await writeFile(join(root, "source.glb"), await packGLB(graph, "model.gltf"));
    const before = await readFile(join(root, "source.glb"));
    expect(await prototypeHasPartFeatures(join(root, "source.glb"))).toBe(true);
    await expect(simplifyGLB(join(root, "source.glb"), () => join(root, "lod1.glb"), [{ level: 1, ratio: .5, maxErrorMeters: .1, lockBorder: true }])).rejects.toMatchObject({ code: "semantic-change" });
    expect(await readFile(join(root, "source.glb"))).toEqual(before);
    await expect(readFile(join(root, "lod1.glb"))).rejects.toThrow();
  });
  it.each([false, true])("repartitions records by object within the shard budget (separate=%s)", async separate => {
    const { root, input, content } = await fixture(), output = join(root, "rewrite");
    const components = Array.from({ length: 60 }, (_, i) => ({ ...component, objectId: separate && i >= 30 ? "span/2" : component.objectId, objectKey: separate && i >= 30 ? "line/span/2" : component.objectKey, componentId: `wire/${String(i).padStart(3, "0")}`, displayName: "x".repeat(80_000), bounds, position: [100, 20, 0], contents: [{ path: content, level: 0 }] }));
    await writeJSON(join(input, "components/shards/0.json"), { schema: "model-optimizer.tileset-component-shard", version: 1, components });
    const objectPath = join(input, "objects/index.json"), objects = JSON.parse(await readFile(objectPath, "utf8"));
    if (separate) objects.objects.push({ ...objects.objects[0], objectId: "span/2", objectKey: "line/span/2" });
    await writeJSON(objectPath, objects);
    const indexPath = join(input, "components/index.json"), index = JSON.parse(await readFile(indexPath, "utf8"));
    index.count = 60; Object.assign(index.shards[0], { count: 60, sha256: await sha256File(join(input, "components/shards/0.json")), first: { objectKey: component.objectKey, componentId: components[0]!.componentId }, last: { objectKey: components.at(-1)!.objectKey, componentId: components.at(-1)!.componentId }, componentTypes: { conductor: 60 } });
    await writeJSON(indexPath, index);
    const catalogPath = join(input, "_pack/catalog.json"), catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    catalog.objectIndexSHA256 = await sha256File(objectPath); catalog.componentIndexSHA256 = await sha256File(indexPath); await writeJSON(catalogPath, catalog);
    const tile = JSON.parse(await readFile(join(input, "tileset.json"), "utf8"));
    tile.asset.extras.catalogSHA256 = await sha256File(catalogPath); await writeJSON(join(input, "tileset.json"), tile);
    const graph = await loadResourceGraph(input); await includeManagement(graph);
    await cp(input, output, { recursive: true });
    await rewritePublicationManagement(graph, output, new Map([...graph.files.keys()].map(path => [path, path])), "b".repeat(32));
    const result = await loadResourceGraph(output); await includeManagement(result);
    const rewritten = result.documents.get("components/index.json")!;
    expect(rewritten.shards).toHaveLength(2);
    if (separate) for (const info of rewritten.shards) expect(info.first.objectKey).toBe(info.last.objectKey);
    const runtimeJSON = await readFile(join(output, "tileset.json"), "utf8");
    expect(runtimeJSON).toBe(JSON.stringify(JSON.parse(runtimeJSON)) + "\n");
    expect(rewritten.shards.reduce((sum: number, info: JSONObject) => sum + info.count, 0)).toBe(60);
    for (const info of rewritten.shards) expect((await stat(join(output, info.path))).size).toBeLessThanOrEqual(4 << 20);
  });
  it.each([true, false])("applies the semantic gate in the complete LOD worker (part=%s)", async part => {
    const root = await mkdtemp(join(tmpdir(), "part-worker-")); roots.push(root);
    const input = join(root, "input"), output = join(root, "lod");
    await model(input, "model.gltf", part ? { partId: "arm", displayName: "横担", sourceName: "tower.obj" } : component, part);
    const graph = await loadGLTFResourceGraph(input, ["model.gltf"]), bytes = await packGLB(graph, "model.gltf");
    const baseGLB = "_build/assets/prototypes/test.glb";
    await writeAtomic(join(input, baseGLB), bytes); await writeAtomic(join(input, "model.glb"), bytes);
    await writeJSON(join(input, "tileset.json"), { asset: { version: "1.1" }, geometricError: 0, root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 0, content: { uri: "model.glb" } } });
    await writeJSON(join(input, "_build/prototypes.json"), [{ prototypeId: "test", assetKey: "test", assetPath: "_build/assets/prototypes/test", baseGLB, lods: [] }]);
    await writeJSON(join(input, "_build/instances.jsonl"), {}); await writeJSON(join(input, "_build/spatial-layout.json"), {}); await writeJSON(join(input, "objects/index.json"), {});
    const paths = [baseGLB, "model.glb", "tileset.json", "_build/prototypes.json", "_build/instances.jsonl", "_build/spatial-layout.json", "objects/index.json"];
    const files = await Promise.all(paths.map(async path => ({ path, sha256: await sha256File(join(input, path)) })));
    await writeJSON(join(input, "_build/build-manifest.json"), { schema: "model-optimizer.lod-input", version: 1, sceneId: "line", sourceHash: "a".repeat(64), prototypeManifest: "_build/prototypes.json", instanceManifest: "_build/instances.jsonl", objectIndex: "objects/index.json", layout: "_build/spatial-layout.json", files });
    const job = runWorker({ ...options(input, output), preset: "tower-v1", maxLevel: 2, resume: false });
    if (!part) {
      await expect(job).rejects.toThrow("not an assembled");
      await expect(readFile(join(output, "tileset.json"))).rejects.toThrow();
    } else {
      const report = await job;
      expect(report.status).toBe("succeeded");
      expect(report.prototypes[0]).toMatchObject({ status: "base-only", lods: [], reason: expect.stringContaining("part feature ownership/survival") });
      expect(await readFile(join(output, baseGLB))).toEqual(bytes);
      await expect(readFile(join(output, "_build/assets/prototypes/test/lod1.glb"))).rejects.toThrow();
    }
  });
});

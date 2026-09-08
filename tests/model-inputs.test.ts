import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshoptDecoder } from "meshoptimizer";
import { packGLB } from "../src/glb-container.js";
import { gltfBuffers, loadGLTFResourceGraph, parseGLB } from "../src/resource-graph.js";
import { runOptimizer } from "../src/optimizer.js";
import { optimizationHelpText, parseOptimizationCLI } from "../src/opt-cli.js";
import { sha256File, writeJSON } from "../src/fs-utils.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const options = (input: string, output: string) => ({ input, output, json: false, verbose: false, help: false, version: false });

describe("automatic model optimization inputs", () => {
  it("writes only a renamed standalone GLB and preserves geometry, root matrix and metadata", async () => {
    const { root, input, glb, positions } = await fixture();
    const output = join(root, "single", "renamed.glb");
    const source = parseGLB(await readFile(glb), glb).json;
    const report = await runOptimizer(options(glb, output));
    expect(report.inputKind).toBe("glb-file");
    expect(report.assets).toHaveLength(1);
    expect(report.assets[0]?.path).toBe("renamed.glb");
    expect(report.assets[0]?.outputSha256).toBe(await sha256File(output));
    expect(report.outputBytes).toBe((await readFile(output)).length);
    expect(await readdir(dirname(output))).toEqual(["renamed.glb"]);
    const graph = await loadGLTFResourceGraph(dirname(output), ["renamed.glb"]);
    const result = graph.documents.get("renamed.glb")!;
    expect(result.nodes).toEqual(source.nodes);
    expect(result.scenes).toEqual(source.scenes);
    expect(result.meshes).toEqual(source.meshes);
    expect(result.asset.extras).toMatchObject({ metersPerUnit: 0.01, business: "unchanged", modelOptimizer: { schema: "model-optimizer.asset-metadata", profile: "web-v1" } });
    expect(result.extensions.EXT_structural_metadata).toEqual(source.extensions.EXT_structural_metadata);
    expect(result.images.every((image: { uri?: string; mimeType?: string }) => !image.uri && image.mimeType === "image/ktx2")).toBe(true);
    expect(result.buffers.every((buffer: { uri?: string }) => buffer.uri === undefined)).toBe(true);
    const buffers = await gltfBuffers(graph, "renamed.glb", result), view = result.bufferViews[0], extension = view.extensions.EXT_meshopt_compression;
    const decoded = Buffer.alloc(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(decoded, extension.count, extension.byteStride, buffers[extension.buffer]!.subarray(extension.byteOffset, extension.byteOffset + extension.byteLength), extension.mode);
    expect(decoded).toEqual(positions);
    expect(report.featureValidation).toMatchObject({ assets: 1, featureSets: 1, propertyRows: 1 });
    expect(await readFile(join(input, "offset.json"), "utf8")).toBe("{\r\n  \"offset\": [1.25, 2.5, 100]\r\n}\r\n");
  });

  it("recursively retains GLB names, empty directories and every auxiliary file byte", async () => {
    const { root, input, glb } = await fixture();
    await copyFile(glb, join(input, "sample.glb"));
    await mkdir(join(input, "empty"));
    await writeJSON(join(input, "nested", "settings.json"), { configuration: [1, 2, 3] });
    await writeFile(join(input, "nested", "reference.gltf"), "auxiliary text: not an optimization input\r\n");
    const output = join(root, "directory-output");
    const report = await runOptimizer(options(input, output));
    expect(report.inputKind).toBe("glb-directory");
    expect(report.assets.map(asset => asset.path)).toEqual(["sample.glb", "models/sample.GLB"]);
    expect(await readdir(join(output, "empty"))).toEqual([]);
    for (const file of ["offset.json", "nested/settings.json", "nested/reference.gltf"]) expect(await readFile(join(output, file))).toEqual(await readFile(join(input, file)));
    for (const asset of report.assets) expect(parseGLB(await readFile(join(output, asset.path)), asset.path).json.extensionsRequired).toContain("EXT_meshopt_compression");
    expect(await readdir(output)).not.toContain("tileset.json");
    expect(await readdir(output)).not.toContain("resources");
    expect(JSON.parse(await readFile(join(output, "optimization-manifest.json"), "utf8")).inputKind).toBe("glb-directory");
    await expect(runOptimizer(options(output, join(root, "twice")))).rejects.toThrow("already optimized");
  });

  it("rejects marked GLBs and a reserved business field before producing output", async () => {
    const { root, input, glb } = await fixture();
    const output = join(root, "optimized.glb");
    await runOptimizer(options(glb, output));
    await expect(runOptimizer(options(output, join(root, "again.glb")))).rejects.toThrow("already optimized");
    await copyFile(output, join(input, "already.glb"));
    await expect(runOptimizer(options(input, join(root, "mixed-output")))).rejects.toThrow("already optimized");
    await expect(readdir(join(root, "mixed-output"))).rejects.toThrow();
    await writeFile(glb, rewriteGLB(await readFile(glb), json => { json.asset.extras.modelOptimizer = { business: "reserved" }; }));
    await expect(runOptimizer(options(glb, join(root, "reserved.glb")))).rejects.toThrow("reserved");
    expect(parseGLB(await readFile(glb), glb).json.asset.extras.modelOptimizer).toEqual({ business: "reserved" });
  });

  it("does not publish a partial directory when a later GLB is malformed", async () => {
    const { root, input, glb } = await fixture();
    const broken = rewriteGLB(await readFile(glb), json => { json.bufferViews[0].byteLength = 999999; });
    await writeFile(join(input, "zz-broken.glb"), broken);
    const output = join(root, "failed");
    await expect(runOptimizer(options(input, output))).rejects.toThrow("invalid bufferView");
    await expect(readdir(output)).rejects.toThrow();
    expect((await readdir(root)).some(name => name.startsWith("failed.tmp-"))).toBe(false);
    expect(await readFile(join(input, "zz-broken.glb"))).toEqual(broken);
  });

  it("rejects existing outputs, intersecting directories and symlinks without modifying them", async () => {
    const { root, input, glb } = await fixture();
    const original = await readFile(glb);
    await expect(runOptimizer(options(glb, glb))).rejects.toThrow("outside input");
    const occupied = join(root, "occupied.glb"); await writeFile(occupied, "keep");
    await expect(runOptimizer(options(glb, occupied))).rejects.toThrow("already exists");
    expect(await readFile(occupied, "utf8")).toBe("keep");
    const occupiedDirectory = join(root, "occupied-directory"); await mkdir(occupiedDirectory); await writeFile(join(occupiedDirectory, "keep.txt"), "keep");
    await expect(runOptimizer(options(input, occupiedDirectory))).rejects.toThrow("must be empty");
    expect(await readFile(join(occupiedDirectory, "keep.txt"), "utf8")).toBe("keep");
    await expect(runOptimizer(options(input, root))).rejects.toThrow("outside input");
    await expect(runOptimizer(options(input, join(input, "inside")))).rejects.toThrow("outside input");
    const alias = join(root, "alias.glb"); await symlink(glb, alias);
    await expect(runOptimizer(options(alias, join(root, "alias-output.glb")))).rejects.toThrow("symlink");
    await symlink(join(root, "missing.glb"), join(root, "dangling.glb"));
    await expect(runOptimizer(options(glb, join(root, "dangling.glb")))).rejects.toThrow("already exists");
    await symlink(glb, join(input, "linked.glb"));
    await expect(runOptimizer(options(input, join(root, "links-output")))).rejects.toThrow("symlink");
    expect(await readFile(glb)).toEqual(original);
  });

  it("allows a new sibling GLB filename and keeps the interface free of mode flags", async () => {
    const { glb } = await fixture();
    const output = join(dirname(glb), "sample-web.glb");
    const parsed = parseOptimizationCLI(["-i", glb, "-o", output]);
    expect((await runOptimizer(parsed)).inputKind).toBe("glb-file");
    expect(optimizationHelpText()).toContain("<model.glb>");
    expect(() => parseOptimizationCLI(["-i", glb, "-o", output, "--mode", "glb"])).toThrow("unknown option");
    await expect(runOptimizer(options(glb, join(dirname(glb), "wrong.json")))).rejects.toThrow(".glb file");
  });
});

async function fixture(): Promise<{ root: string; input: string; glb: string; positions: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), "optimizer-inputs-")); roots.push(root);
  const input = join(root, "legacy"), source = join(root, "source");
  await mkdir(source); await mkdir(join(input, "models"), { recursive: true });
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const geometry = Buffer.concat([positions, Buffer.from(new Uint16Array([0, 1, 2]).buffer), Buffer.alloc(2), Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer), Buffer.alloc(12), Buffer.from("tower:211"), Buffer.alloc(3), Buffer.from(new Uint32Array([0, 9]).buffer)]);
  await writeFile(join(source, "geometry.bin"), geometry);
  await writeFile(join(source, "material.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeJSON(join(source, "model.gltf"), {
    asset: { version: "2.0", extras: { metersPerUnit: 0.01, business: "unchanged" } }, scene: 0,
    scenes: [{ nodes: [0], extras: { sourceUp: "Z" } }], nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 12.25, 45.5, 1000, 1] }],
    buffers: [{ uri: "geometry.bin", byteLength: geometry.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: 24 }, { buffer: 0, byteOffset: 68, byteLength: 12 }, { buffer: 0, byteOffset: 80, byteLength: 9 }, { buffer: 0, byteOffset: 92, byteLength: 8 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }, { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" }, { bufferView: 3, componentType: 5126, count: 3, type: "SCALAR" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2, _FEATURE_ID_0: 3 }, indices: 1, material: 0, extensions: { EXT_mesh_features: { featureIds: [{ attribute: 0, featureCount: 1, propertyTable: 0 }] } } }] }],
    textures: [{ source: 0 }], images: [{ uri: "material.png" }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    extensionsUsed: ["EXT_mesh_features", "EXT_structural_metadata"],
    extensions: { EXT_structural_metadata: { schema: { id: "business", classes: { object: { properties: { id: { type: "STRING" } } } } }, propertyTables: [{ class: "object", count: 1, properties: { id: { values: 4, stringOffsets: 5 } } }] } },
  });
  const glb = join(input, "models", "sample.GLB");
  await writeFile(glb, await packGLB(await loadGLTFResourceGraph(source, ["model.gltf"]), "model.gltf"));
  await writeFile(join(input, "offset.json"), "{\r\n  \"offset\": [1.25, 2.5, 100]\r\n}\r\n");
  return { root, input, glb, positions };
}

function rewriteGLB(bytes: Buffer, change: (json: Record<string, any>) => void): Buffer {
  const { json, binary } = parseGLB(bytes, "fixture"); change(json);
  const text = Buffer.from(JSON.stringify(json)), jsonLength = text.length + (4 - text.length % 4) % 4;
  const result = Buffer.alloc(20 + jsonLength + (binary ? 8 + binary.length : 0));
  result.write("glTF"); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(0x20, 20, 20 + jsonLength); text.copy(result, 20);
  if (binary) { result.writeUInt32LE(binary.length, 20 + jsonLength); result.writeUInt32LE(0x004e4942, 24 + jsonLength); binary.copy(result, 28 + jsonLength); }
  return result;
}

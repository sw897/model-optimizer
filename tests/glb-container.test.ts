import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { packGLB } from "../src/glb-container.js";
import { createDecodeIO } from "../src/glb.js";
import { gltfBuffers, loadResourceGraph, parseGLB, visitURIs, type JSONObject } from "../src/resource-graph.js";
import { writeJSON } from "../src/fs-utils.js";
import { encodeKTX2, findBasisuBinary } from "../src/texture-codec.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function fixture(): Promise<{ root: string; json: JSONObject }> {
  const root = await mkdtemp(join(tmpdir(), "glb-container-")); roots.push(root);
  const json: JSONObject = {
    asset: { version: "2.0", extras: { source: "线路" } },
    buffers: [{ uri: "geometry.bin", byteLength: positions.length }],
    bufferViews: [{ buffer: 0, byteLength: positions.length }],
    accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 3, min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    nodes: [{ mesh: 0, translation: [100, 200, 300], rotation: [0, 0, 0, 1], scale: [1, 2, 3], extras: { objectId: "211" } }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
  await writeFile(join(root, "geometry.bin"), positions);
  return { root, json };
}

describe("standalone GLB container", () => {
  it("embeds equal physical buffers only once without changing accessor identities", async () => {
    const { root, json } = await fixture();
    await writeFile(join(root, "duplicate.bin"), positions);
    json.buffers.push({ uri: "duplicate.bin", byteLength: positions.length });
    json.bufferViews.push({ buffer: 1, byteLength: positions.length });
    json.accessors.push({ ...json.accessors[0], bufferView: 1, name: "separate semantic" });
    json.meshes.push({ primitives: [{ attributes: { POSITION: 1 } }] });
    json.nodes.push({ mesh: 1, translation: [9, 8, 7] });
    json.scenes[0].nodes.push(1);
    await writeJSON(join(root, "tower.gltf"), json);
    const packed = parseGLB(await packGLB(await loadResourceGraph(root, "tower.gltf"), "tower.gltf"), "tower.glb");
    expect(packed.json.buffers[0].byteLength).toBe(positions.length);
    expect(packed.json.bufferViews[0]).toEqual(packed.json.bufferViews[1]);
    expect(packed.binary!.subarray(0, positions.length)).toEqual(positions);
    expect(packed.json.accessors).toEqual(json.accessors);
    expect(packed.json.nodes).toEqual(json.nodes);
    expect(packed.json.meshes).toEqual(json.meshes);
  });
  it("embeds multiple buffers and images without changing scene transforms or materials", async () => {
    const { root, json } = await fixture();
    const indices = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
    json.buffers.push({ uri: `data:application/octet-stream;base64,${indices.toString("base64")}`, byteLength: indices.length });
    json.bufferViews.push({ buffer: 1, byteLength: indices.length });
    json.accessors.push({ bufferView: 1, componentType: 5123, type: "SCALAR", count: 3 });
    json.meshes[0].primitives[0].indices = 1;
    json.meshes[0].primitives[0].material = 0;
    json.nodes.push({ mesh: 0, translation: [400, 500, 600], extras: { componentId: "second-insulator" } });
    json.scenes[0].nodes.push(1);
    json.images = [{ uri: "颜色%20图.png", extras: { channel: "base" } }, { uri: `data:image/png;base64,${png.toString("base64")}` }];
    json.textures = [{ source: 0 }];
    json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }, extras: { name: "绝缘子" } }];
    await writeFile(join(root, "颜色 图.png"), png);
    await writeJSON(join(root, "tower.gltf"), json);
    const graph = await loadResourceGraph(root, "tower.gltf");
    const before = structuredClone(graph.documents.get("tower.gltf"));
    const bytes = await packGLB(graph, "tower.gltf"), result = parseGLB(bytes, "tower.glb");
    expect(result.json.buffers).toEqual([{ byteLength: result.json.buffers[0].byteLength }]);
    expect(result.json.nodes).toEqual(json.nodes);
    expect(result.json.materials).toEqual(json.materials);
    expect(result.json.asset).toEqual(json.asset);
    expect(result.json.bufferViews[1].byteOffset).toBe(40);
    for (const image of result.json.images) {
      expect(image.uri).toBeUndefined(); expect(image.mimeType).toBe("image/png");
      const view = result.json.bufferViews[image.bufferView];
      expect(view.byteOffset % 4).toBe(0);
      expect(result.binary!.subarray(view.byteOffset, view.byteOffset + view.byteLength)).toEqual(png);
    }
    expect(result.json.images[0].extras).toEqual(json.images[0].extras);
    const uris: string[] = []; visitURIs(result.json, (_object, _key, uri) => uris.push(uri));
    expect(uris).toEqual([]);
    expect(graph.documents.get("tower.gltf")).toEqual(before);
    const io = await createDecodeIO(), decoded = await io.readBinary(bytes);
    expect(decoded.getRoot().listMeshes()).toHaveLength(1);
    expect(decoded.getRoot().listNodes()).toHaveLength(2);
    expect(decoded.getRoot().listNodes()[0]!.getMesh()).toBe(decoded.getRoot().listNodes()[1]!.getMesh());
    expect(Array.from(decoded.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray()!)).toEqual(Array.from(new Float32Array(positions.buffer, positions.byteOffset, 9)));
    decoded.getRoot().dispose();
  });

  it("remaps Meshopt physical buffers while retaining virtual fallback and inlining metadata schema", async () => {
    const { root, json } = await fixture();
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    const encoded = Buffer.from(MeshoptEncoder.encodeGltfBuffer(positions, 3, 12, "ATTRIBUTES"));
    const strings = Buffer.concat([Buffer.from("pole"), Buffer.from(new Uint32Array([0, 4]).buffer)]);
    await writeFile(join(root, "encoded.bin"), encoded);
    await writeFile(join(root, "metadata.bin"), strings);
    json.buffers = [{ uri: "metadata.bin", byteLength: strings.length }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }, { uri: "encoded.bin", byteLength: encoded.length }];
    json.bufferViews = [
      { buffer: 1, byteLength: 36, extensions: { EXT_meshopt_compression: { buffer: 2, byteLength: encoded.length, byteStride: 12, count: 3, mode: "ATTRIBUTES" } } },
      { buffer: 0, byteLength: 4 }, { buffer: 0, byteOffset: 4, byteLength: 8 },
    ];
    const schema = { id: "objects", classes: { component: { properties: { name: { type: "STRING" } } } } };
    json.extensions = { EXT_structural_metadata: { schemaUri: "schema.json", propertyTables: [{ class: "component", count: 1, properties: { name: { values: 1, stringOffsets: 2, stringOffsetType: "UINT32" } } }] } };
    json.extensionsUsed = ["EXT_meshopt_compression", "EXT_structural_metadata"];
    json.extensionsRequired = ["EXT_meshopt_compression"];
    await writeJSON(join(root, "schema.json"), schema);
    await writeJSON(join(root, "tower.gltf"), json);
    const bytes = await packGLB(await loadResourceGraph(root, "tower.gltf"), "tower.gltf");
    await writeFile(join(root, "tower.glb"), bytes);
    const graph = await loadResourceGraph(root, "tower.glb"), result = graph.documents.get("tower.glb")!;
    expect(graph.files.size).toBe(1);
    expect(result.buffers).toHaveLength(2);
    expect(result.buffers[1]).toEqual(json.buffers[1]);
    expect(result.extensions.EXT_structural_metadata.schemaUri).toBeUndefined();
    expect(result.extensions.EXT_structural_metadata.schema).toEqual(schema);
    expect(result.extensions.EXT_structural_metadata.propertyTables).toEqual(json.extensions.EXT_structural_metadata.propertyTables);
    const bufferData = await gltfBuffers(graph, "tower.glb", result), view = result.bufferViews[0], compression = view.extensions.EXT_meshopt_compression;
    expect(view.buffer).toBe(1); expect(compression.buffer).toBe(0); expect(compression.byteOffset).toBe(16);
    expect(bufferData[1]!.length).toBe(0);
    const decoded = Buffer.alloc(36);
    MeshoptDecoder.decodeGltfBuffer(decoded, 3, 12, bufferData[0]!.subarray(compression.byteOffset, compression.byteOffset + compression.byteLength), "ATTRIBUTES");
    expect(decoded).toEqual(positions);
    expect(bufferData[0]!.subarray(0, strings.length)).toEqual(strings);
    const document = await (await createDecodeIO()).readBinary(bytes);
    expect(document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getCount()).toBe(3);
    document.getRoot().dispose();
  });

  it("shares embedded image bytes across image indices and URI spellings without merging their semantics", async () => {
    const { root, json } = await fixture();
    await writeFile(join(root, "first.png"), png);
    await writeFile(join(root, "identical.png"), png);
    json.images = [
      { uri: "first.png", name: "insulator", extras: { source: "A" } },
      { uri: "first.png", name: "fitting", extras: { source: "B" } },
      { uri: "identical.png", name: "wire" },
      { uri: `data:image/png;base64,${png.toString("base64")}`, name: "tower" },
    ];
    json.samplers = [{ wrapS: 33071 }, { wrapS: 10497 }];
    json.textures = json.images.map((_image: JSONObject, source: number) => ({ source, sampler: source % 2 }));
    json.materials = json.images.map((_image: JSONObject, index: number) => ({ name: `material-${index}`, pbrMetallicRoughness: { baseColorTexture: { index } } }));
    await writeJSON(join(root, "tower.gltf"), json);
    const graph = await loadResourceGraph(root, "tower.gltf"), before = structuredClone(graph.documents.get("tower.gltf"));
    const packed = parseGLB(await packGLB(graph, "tower.gltf"), "tower.glb");
    expect(packed.json.images).toHaveLength(4);
    expect(new Set(packed.json.images.map((image: JSONObject) => image.bufferView)).size).toBe(1);
    expect(packed.json.bufferViews).toHaveLength(2);
    expect(packed.json.buffers[0].byteLength).toBe(40 + png.length);
    for (const [index, image] of packed.json.images.entries()) {
      expect(image).toEqual({ ...json.images[index], uri: undefined, mimeType: "image/png", bufferView: 1 });
    }
    expect(packed.json.textures).toEqual(json.textures);
    expect(packed.json.samplers).toEqual(json.samplers);
    expect(packed.json.materials).toEqual(json.materials);
    expect(graph.documents.get("tower.gltf")).toEqual(before);
  });

  it("keeps 64-bit metadata aligned when combining buffers", async () => {
    const { root, json } = await fixture();
    const metadata = Buffer.alloc(16);
    metadata.writeDoubleLE(1234.5, 0); metadata.writeBigUInt64LE(9007199254740993n, 8);
    await writeFile(join(root, "metadata.bin"), metadata);
    json.buffers.push({ uri: "metadata.bin", byteLength: metadata.length });
    json.bufferViews.push({ buffer: 1, byteOffset: 0, byteLength: 8 }, { buffer: 1, byteOffset: 8, byteLength: 8 });
    json.extensionsUsed = ["EXT_structural_metadata"];
    json.extensions = { EXT_structural_metadata: {
      schema: { id: "objects", classes: { tower: { properties: { height: { type: "SCALAR", componentType: "FLOAT64" }, id: { type: "SCALAR", componentType: "UINT64" } } } } },
      propertyTables: [{ class: "tower", count: 1, properties: { height: { values: 1 }, id: { values: 2 } } }],
    } };
    await writeJSON(join(root, "tower.gltf"), json);
    const graph = await loadResourceGraph(root, "tower.gltf");
    const packed = await packGLB(graph, "tower.gltf"), result = parseGLB(packed, "tower.glb");
    const heightView = result.json.bufferViews[1], idView = result.json.bufferViews[2];
    expect(heightView.byteOffset % 8).toBe(0); expect(idView.byteOffset % 8).toBe(0);
    expect(result.binary!.readDoubleLE(heightView.byteOffset)).toBe(1234.5);
    expect(result.binary!.readBigUInt64LE(idView.byteOffset)).toBe(9007199254740993n);
    expect(result.json.extensions).toEqual(json.extensions);
    for (let length = 0; length < 8; length++) {
      graph.documents.get("tower.gltf")!.asset.extras.note = "x".repeat(length);
      const bytes = await packGLB(graph, "tower.gltf");
      expect((28 + bytes.readUInt32LE(12)) % 8).toBe(0);
      expect(bytes.length % 8).toBe(0);
    }
  });

  it("retains an actual BIN fallback instead of treating it as a virtual buffer", async () => {
    const { root, json } = await fixture();
    await writeJSON(join(root, "tower.gltf"), json);
    const initial = await packGLB(await loadResourceGraph(root, "tower.gltf"), "tower.gltf");
    await writeFile(join(root, "tower.glb"), initial);
    const graph = await loadResourceGraph(root, "tower.glb"), source = graph.documents.get("tower.glb")!;
    source.buffers[0].extensions = { EXT_meshopt_compression: { fallback: true } };
    const packed = parseGLB(await packGLB(graph, "tower.glb"), "tower.glb");
    expect(packed.json.bufferViews[0].buffer).toBe(0);
    expect(packed.json.buffers[0].extensions).toBeUndefined();
    expect(packed.binary!.subarray(0, positions.length)).toEqual(positions);
  });

  it("embeds valid KTX2 bytes with codec references intact", async () => {
    const { root, json } = await fixture();
    const ktx2 = await encodeKTX2(png, "color", await findBasisuBinary());
    await writeFile(join(root, "color.ktx2"), ktx2);
    await writeFile(join(root, "same-bytes.ktx2"), ktx2);
    json.images = [
      { uri: "color.ktx2", mimeType: "image/ktx2", name: "base" },
      { uri: "color.ktx2", mimeType: "image/ktx2", name: "same URI" },
      { uri: "same-bytes.ktx2", mimeType: "image/ktx2", name: "same bytes" },
    ];
    json.textures = json.images.map((_image: JSONObject, source: number) => ({ extensions: { KHR_texture_basisu: { source } } }));
    json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    json.meshes[0].primitives[0].material = 0;
    json.extensionsUsed = ["KHR_texture_basisu"]; json.extensionsRequired = ["KHR_texture_basisu"];
    await writeJSON(join(root, "tower.gltf"), json);
    const bytes = await packGLB(await loadResourceGraph(root, "tower.gltf"), "tower.gltf"), result = parseGLB(bytes, "tower.glb");
    expect(result.json.textures).toEqual(json.textures);
    expect(result.json.images).toHaveLength(3);
    expect(new Set(result.json.images.map((image: JSONObject) => image.bufferView)).size).toBe(1);
    expect(result.json.buffers[0].byteLength).toBe(40 + ktx2.length);
    expect(result.json.images[0].mimeType).toBe("image/ktx2");
    const view = result.json.bufferViews[result.json.images[0].bufferView];
    expect(result.binary!.subarray(view.byteOffset, view.byteOffset + view.byteLength)).toEqual(ktx2);
    const document = await (await createDecodeIO()).readBinary(bytes);
    expect(document.getRoot().listTextures()[0]!.getMimeType()).toBe("image/ktx2");
    document.getRoot().dispose();
  }, 30000);

  it("fails closed for unresolved resources and invalid buffer ranges", async () => {
    const { root, json } = await fixture();
    await writeJSON(join(root, "tower.gltf"), json);
    const graph = await loadResourceGraph(root, "tower.gltf"), source = graph.documents.get("tower.gltf")!;
    source.bufferViews[0].byteOffset = 100;
    await expect(packGLB(graph, "tower.gltf")).rejects.toThrow("invalid embedded buffer range");
    source.bufferViews[0].byteOffset = 0;
    source.extensions = { VENDOR_resource: { uri: "outside.bin" } };
    await expect(packGLB(graph, "tower.gltf")).rejects.toThrow("cannot be embedded");
    expect(await readFile(join(root, "geometry.bin"))).toEqual(positions);
  });
});

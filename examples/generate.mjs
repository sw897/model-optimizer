import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../artifacts/example", import.meta.url)));
await mkdir(dirname(root), { recursive: true });
await mkdir(root); // An existing destination must never be overwritten.

try {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = [], normals = [], uvs = [], indices = [];
  const width = 32;
  for (let y = 0; y <= width; y++) for (let x = 0; x <= width; x++) {
    positions.push(x, y, 0.05 * Math.sin(x * 0.3) * Math.cos(y * 0.2));
    normals.push(0, 0, 1);
    uvs.push(x / width, y / width);
  }
  const vertex = (x, y) => y * (width + 1) + x;
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const a = vertex(x, y), b = vertex(x + 1, y), c = vertex(x + 1, y + 1), d = vertex(x, y + 1);
    indices.push(a, b, c, a, c, d);
  }
  const accessor = (name, type, array) => document.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const color = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [36, 105, 148] : [220, 230, 218];
    color.forEach((value, channel) => { pixels[(y * 64 + x) * 3 + channel] = value; });
  }
  const png = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const texture = document.createTexture("procedural-checker").setMimeType("image/png").setImage(png);
  const solid = async (name, rgb) => document.createTexture(name).setMimeType("image/png").setImage(await sharp(Buffer.from(rgb), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer());
  const normal = await solid("procedural-normal", [128, 128, 255]);
  const data = await solid("procedural-roughness", [255, 192, 0]);
  const material = document.createMaterial("synthetic-material").setBaseColorTexture(texture).setNormalTexture(normal).setMetallicRoughnessTexture(data).setMetallicFactor(0);
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", accessor("positions", "VEC3", new Float32Array(positions)))
    .setAttribute("NORMAL", accessor("normals", "VEC3", new Float32Array(normals)))
    .setAttribute("TEXCOORD_0", accessor("uvs", "VEC2", new Float32Array(uvs)))
    .setIndices(accessor("indices", "SCALAR", new Uint32Array(indices)))
    .setMaterial(material);
  document.createScene("synthetic-scene").addChild(document.createNode("synthetic-grid").setMesh(document.createMesh().addPrimitive(primitive)));
  const bytes = await new NodeIO().writeBinary(document);
  const write = async (path, value) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  const json = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`);
  const tileset = { asset: { version: "1.1" }, geometricError: 0, root: { boundingVolume: { sphere: [16, 16, 0, 30] }, geometricError: 0, content: { uri: "content/model.glb" } } };
  await write("model.glb", bytes);
  await write("models/model.glb", bytes);
  await json("models/offset.json", { synthetic: true, models: [{ file: "model.glb", offset: [0, 0, 0] }] });
  await write("tileset/content/model.glb", bytes);
  await json("tileset/tileset.json", tileset);

  const prefix = "lod-input/";
  const base = "_build/assets/prototypes/demo/grid";
  await write(`${prefix}content/model.glb`, bytes);
  await json(`${prefix}tileset.json`, tileset);
  await write(`${prefix}${base}.glb`, bytes);
  await json(`${prefix}_build/prototypes.json`, [{ prototypeId: "synthetic-grid", prototypeKey: "synthetic:grid", name: "Synthetic grid", assetKey: "demo/grid", assetPath: base, sourcePath: "synthetic-grid", role: "scene-relative", baseGLB: `${base}.glb`, lods: [] }]);
  await write(`${prefix}_build/instances.jsonl`, "");
  await json(`${prefix}_build/spatial-layout.json`, {});
  await json(`${prefix}objects/index.json`, { schema: "model-optimizer.tileset-objects", version: 1, objects: [] });
  const paths = ["tileset.json", "content/model.glb", `${base}.glb`, "_build/prototypes.json", "_build/instances.jsonl", "_build/spatial-layout.json", "objects/index.json"];
  const hash = value => createHash("sha256").update(value).digest("hex");
  await json(`${prefix}_build/build-manifest.json`, { schema: "model-optimizer.lod-input", version: 1, sceneId: "synthetic-demo", sourceHash: hash(bytes), prototypeManifest: "_build/prototypes.json", instanceManifest: "_build/instances.jsonl", objectIndex: "objects/index.json", layout: "_build/spatial-layout.json", files: await Promise.all(paths.map(async path => ({ path, sha256: hash(await readFile(join(root, prefix, path))) }))) });
  console.log(`Generated Apache-2.0 examples in ${root} (${indices.length / 3} triangles; no external assets).`);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}

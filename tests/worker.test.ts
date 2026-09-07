import { Accessor, Document, NodeIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco, meshopt } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptEncoder } from "meshoptimizer";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCLI } from "../src/cli.js";
import { createIO, inspectGLB, simplifyGLB } from "../src/glb.js";
import { sha256File, writeJSON } from "../src/fs-utils.js";
import { loadInputSnapshot } from "../src/protocol.js";
import { runWorker } from "../src/worker.js";

const temporaryRoots: string[] = [];

describe("model-lod worker", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("parses the standalone worker interface", () => {
    expect(parseCLI(["--input", "in", "--output", "out", "--max-level", "0", "--preset", "base-only"]).maxLevel).toBe(0);
    expect(() => parseCLI(["--input", "in", "--output", "out", "--max-level", "-1"])).toThrow();
  });

  it("generates deterministic LOD assets and a model manifest", async () => {
    const input = await createCanonicalFixture();
    const output = join(input, "..", "stage2-output");
    const outputRepeat = join(input, "..", "stage2-output-repeat");
    const report = await runWorker({
      input,
      output,
      preset: "tower-v1",
      maxLevel: 1,
      json: false,
      verbose: false,
      resume: false,
      help: false,
      version: false,
    });
    temporaryRoots.push(input, output);

    expect(report.status).toBe("succeeded");
    expect(report.prototypes).toHaveLength(1);
    expect(report.prototypes[0]?.lods).toHaveLength(1);

    const manifest = JSON.parse(await readFile(join(output, "lod-manifest.json"), "utf8")) as {
      schema: string;
      baseBuildManifestHash: string;
      prototypes: Array<{ lods: Array<{ level: number; path: string; sha256: string; method: string }> }>;
    };
    expect(manifest.schema).toBe("model-optimizer.lod-manifest");
    expect(manifest.baseBuildManifestHash).toBe(await sha256File(join(input, "_build/build-manifest.json")));
    expect(manifest.prototypes[0]?.lods[0]?.level).toBe(1);
    expect(manifest.prototypes[0]?.lods[0]?.method).toBe("meshopt-simplify");
    expect(manifest.prototypes[0]?.lods[0]?.sha256).toHaveLength(64);
    expect(await readFile(join(output, "_build", "assets", "prototypes", "scene-relative", "fixture", "lod1.glb"))).toHaveLength(
      report.prototypes[0]?.lods[0]?.outputBytes ?? 0,
    );
    expect(await readFile(join(output, "tileset.json"), "utf8")).toBe(await readFile(join(input, "tileset.json"), "utf8"));

    await runWorker({
      input,
      output: outputRepeat,
      preset: "tower-v1",
      maxLevel: 1,
      json: false,
      verbose: false,
      resume: false,
      help: false,
      version: false,
    });
    temporaryRoots.push(outputRepeat);
    expect(await readFile(join(outputRepeat, "_build", "assets", "prototypes", "scene-relative", "fixture", "lod1.glb"))).toEqual(
      await readFile(join(output, "_build", "assets", "prototypes", "scene-relative", "fixture", "lod1.glb")),
    );
    expect(await readFile(join(outputRepeat, "lod-manifest.json"))).toEqual(
      await readFile(join(output, "lod-manifest.json")),
    );
  });

  it("supports the compliance-only max-level 0 path", async () => {
    const input = await createCanonicalFixture();
    const output = join(input, "..", "stage2-base");
    const report = await runWorker({
      input,
      output,
      preset: "base-only",
      maxLevel: 0,
      json: false,
      verbose: false,
      resume: false,
      help: false,
      version: false,
    });
    temporaryRoots.push(input, output);
    expect(report.prototypes[0]?.status).toBe("base-only");
    await expect(readFile(join(output, "_build", "assets", "prototypes", "scene-relative", "fixture", "lod1.glb"))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(output, "lod-manifest.json"), "utf8")) as {
      prototypes: Array<{ lods: unknown[] }>;
    };
    expect(manifest.prototypes[0]?.lods).toHaveLength(0);
  });

  it("falls back to a scene-wide base-only result for unsupported or tiny geometry", async () => {
    const input = await createCanonicalFixture("line");
    const output = join(input, "..", "stage2-line-fallback");
    const report = await runWorker({
      input,
      output,
      preset: "tower-v1",
      maxLevel: 1,
      json: false,
      verbose: false,
      resume: false,
      help: false,
      version: false,
    });
    temporaryRoots.push(input, output);

    expect(report.status).toBe("succeeded");
    expect(report.prototypes[0]?.status).toBe("base-only");
    expect(report.prototypes[0]?.reason).toContain("unsupported primitive modes");
    const manifest = JSON.parse(await readFile(join(output, "lod-manifest.json"), "utf8")) as {
      prototypes: Array<{ lods: unknown[] }>;
    };
    expect(manifest.prototypes[0]?.lods).toHaveLength(0);
    await expect(readFile(join(output, "_build", "assets", "prototypes", "scene-relative", "fixture", "lod1.glb"))).rejects.toThrow();

    const tinyInput = await createCanonicalFixture("triangle");
    const tinyOutput = join(tinyInput, "..", "stage2-tiny-fallback");
    const tinyReport = await runWorker({
      input: tinyInput,
      output: tinyOutput,
      preset: "tower-v1",
      maxLevel: 1,
      json: false,
      verbose: false,
      resume: false,
      help: false,
      version: false,
    });
    temporaryRoots.push(tinyInput, tinyOutput);
    expect(tinyReport.status).toBe("succeeded");
    expect(tinyReport.prototypes[0]?.status).toBe("base-only");
    expect(tinyReport.prototypes[0]?.reason).toContain("did not reduce triangles");
  });

  it("rejects a prototype manifest path that escapes the scene root", async () => {
    const input = await createCanonicalFixture();
    temporaryRoots.push(input);
    const scenePath = join(input, "_build/build-manifest.json");
    const scene = JSON.parse(await readFile(scenePath, "utf8")) as Record<string, unknown>;
    scene.prototypeManifest = "../outside-prototypes.json";
    await writeFile(scenePath, JSON.stringify(scene));
    await expect(loadInputSnapshot(input)).rejects.toThrow("asset path escapes scene root");
  });

  it("keeps accepted tower LODs when another prototype is base-only", async () => {
    const input = await createCanonicalFixture();
    const line = await createCanonicalFixture("line");
    const output = join(input, "..", "mixed-lod-output");
    temporaryRoots.push(input, line, output);
    const linePath = "_build/assets/prototypes/scene-relative/line.glb";
    await copyFile(join(line, "_build/assets/prototypes/scene-relative/fixture.glb"), join(input, linePath));
    const prototypesPath = join(input, "_build/prototypes.json");
    const prototypes = JSON.parse(await readFile(prototypesPath, "utf8"));
    prototypes.push({ ...prototypes[0], prototypeId: "prototype-line", name: "line", assetKey: "scene-relative/line", assetPath: "_build/assets/prototypes/scene-relative/line", baseGLB: linePath });
    await writeJSON(prototypesPath, prototypes);
    const buildPath = join(input, "_build/build-manifest.json");
    const build = JSON.parse(await readFile(buildPath, "utf8"));
    build.files.push({ path: linePath, sha256: await sha256File(join(input, linePath)) });
    build.files.find((file: {path: string}) => file.path === "_build/prototypes.json").sha256 = await sha256File(prototypesPath);
    await writeJSON(buildPath, build);
    const report = await runWorker({ input, output, preset: "tower-v1", maxLevel: 2, json: false, verbose: false, resume: false, help: false, version: false });
    expect(report.prototypes.find(p => p.prototypeId === "prototype-000001")?.lods.length).toBeGreaterThan(0);
    expect(report.prototypes.find(p => p.prototypeId === "prototype-line")?.status).toBe("base-only");
    const manifest = JSON.parse(await readFile(join(output,"lod-manifest.json"),"utf8"));
    expect(manifest.version).toBe(3);
    expect(manifest.sceneId).toBe("line-a");
    expect(manifest.prototypes.find((p: {prototypeId:string}) => p.prototypeId === "prototype-line").status).toBe("base-only");
  });

  it("rejects a modified source asset before writing stage 2", async () => {
    const input = await createCanonicalFixture(); temporaryRoots.push(input);
    await writeFile(join(input,"content/fixture.glb"),"tampered");
    await expect(loadInputSnapshot(input)).rejects.toThrow();
  });

  it("decodes Draco-compressed GLB input with the locked decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-lod-draco-"));
    temporaryRoots.push(root);
    const document = new Document();
    const buffer = document.createBuffer();
    const position = document
      .createAccessor("POSITION")
      .setType(Accessor.Type.VEC3)
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]))
      .setBuffer(buffer);
    const indices = document
      .createAccessor("INDICES")
      .setType(Accessor.Type.SCALAR)
      .setArray(new Uint16Array([0, 1, 2, 1, 3, 2]))
      .setBuffer(buffer);
    const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(indices);
    const mesh = document.createMesh("draco-mesh").addPrimitive(primitive);
    document.createScene("draco-scene").addChild(document.createNode("draco-node").setMesh(mesh));
    const encoder = await draco3d.createEncoderModule();
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.encoder": encoder });
    await document.transform(draco({ method: "edgebreaker" }));
    const path = join(root, "compressed.glb");
    await writeFile(path, await io.writeBinary(document));
    const stats = await inspectGLB(path);
    expect(stats.triangleCount).toBe(2);
  });

  it("simplifies Draco-compressed input with the locked encoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-lod-draco-simplify-"));
    temporaryRoots.push(root);
    const document = new Document();
    const buffer = document.createBuffer();
    const width = 12;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let y = 0; y <= width; y += 1) {
      for (let x = 0; x <= width; x += 1) positions.push(x, y, Math.sin(x * 0.3) * Math.cos(y * 0.2) * 0.1);
    }
    const vertex = (x: number, y: number) => y * (width + 1) + x;
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = vertex(x, y);
        const b = vertex(x + 1, y);
        const c = vertex(x + 1, y + 1);
        const d = vertex(x, y + 1);
        indices.push(a, b, c, a, c, d);
      }
    }
    const position = document
      .createAccessor("POSITION")
      .setType(Accessor.Type.VEC3)
      .setArray(new Float32Array(positions))
      .setBuffer(buffer);
    const index = document
      .createAccessor("INDICES")
      .setType(Accessor.Type.SCALAR)
      .setArray(new Uint32Array(indices))
      .setBuffer(buffer);
    const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(index);
    const mesh = document.createMesh("draco-grid").addPrimitive(primitive);
    document.createScene("draco-scene").addChild(document.createNode("draco-node").setMesh(mesh));
    const encoder = await draco3d.createEncoderModule();
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.encoder": encoder });
    await document.transform(draco({ method: "edgebreaker" }));
    const inputPath = join(root, "input.glb");
    await writeFile(inputPath, await io.writeBinary(document));

    const result = await simplifyGLB(
      inputPath,
      (level) => join(root, `lod${level}.glb`),
      [{ level: 1, ratio: 0.35, maxErrorMeters: 0.08, lockBorder: true }],
    );
    expect(result.levels[0]?.outputTriangles).toBeLessThan(result.levels[0]?.inputTriangles ?? 0);
    expect(await inspectGLB(join(root, "lod1.glb"))).toMatchObject({ unsupportedPrimitives: 0 });
  });

  it("simplifies Meshopt-compressed input with the locked encoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-lod-meshopt-simplify-"));
    temporaryRoots.push(root);
    const document = new Document();
    const buffer = document.createBuffer();
    const width = 12;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let y = 0; y <= width; y += 1) {
      for (let x = 0; x <= width; x += 1) positions.push(x, y, Math.sin(x * 0.3) * Math.cos(y * 0.2) * 0.1);
    }
    const vertex = (x: number, y: number) => y * (width + 1) + x;
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = vertex(x, y);
        const b = vertex(x + 1, y);
        const c = vertex(x + 1, y + 1);
        const d = vertex(x, y + 1);
        indices.push(a, b, c, a, c, d);
      }
    }
    const position = document
      .createAccessor("POSITION")
      .setType(Accessor.Type.VEC3)
      .setArray(new Float32Array(positions))
      .setBuffer(buffer);
    const index = document
      .createAccessor("INDICES")
      .setType(Accessor.Type.SCALAR)
      .setArray(new Uint32Array(indices))
      .setBuffer(buffer);
    const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(index);
    const mesh = document.createMesh("meshopt-grid").addPrimitive(primitive);
    document.createScene("meshopt-scene").addChild(document.createNode("meshopt-node").setMesh(mesh));
    await MeshoptEncoder.ready;
    await document.transform(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
    const io = createIO().registerDependencies({ "meshopt.encoder": MeshoptEncoder });
    const inputPath = join(root, "input.glb");
    await writeFile(inputPath, await io.writeBinary(document));

    const result = await simplifyGLB(
      inputPath,
      (level) => join(root, `lod${level}.glb`),
      [{ level: 1, ratio: 0.35, maxErrorMeters: 0.08, lockBorder: true }],
    );
    expect(result.levels[0]?.outputTriangles).toBeLessThan(result.levels[0]?.inputTriangles ?? 0);
    expect(await inspectGLB(join(root, "lod1.glb"))).toMatchObject({ unsupportedPrimitives: 0 });
  });
});

async function createCanonicalFixture(geometry: "grid" | "line" | "triangle" = "grid"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "model-lod-fixture-"));
  const prototypeRoot = join(root, "_build", "assets", "prototypes", "scene-relative", "fixture");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(prototypeRoot, { recursive: true });

  const document = new Document();
  const buffer = document.createBuffer();
  const width = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  if (geometry === "line") {
    positions.push(0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0);
  } else if (geometry === "triangle") {
    positions.push(0, 0, 0, 1, 0, 0, 0, 1, 0);
    indices.push(0, 1, 2);
  } else {
    for (let y = 0; y <= width; y += 1) {
      for (let x = 0; x <= width; x += 1) {
        positions.push(x, y, Math.sin(x * 0.3) * Math.cos(y * 0.2) * 0.1);
      }
    }
    const vertex = (x: number, y: number) => y * (width + 1) + x;
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = vertex(x, y);
        const b = vertex(x + 1, y);
        const c = vertex(x + 1, y + 1);
        const d = vertex(x, y + 1);
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  const positionAccessor = document
    .createAccessor("POSITION")
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positionAccessor);
  if (geometry === "line") {
    primitive.setMode(Primitive.Mode.LINES);
  } else {
    const indexAccessor = document
      .createAccessor("INDICES")
      .setType(Accessor.Type.SCALAR)
      .setArray(new Uint32Array(indices))
      .setBuffer(buffer);
    primitive.setIndices(indexAccessor);
  }
  const material = document.createMaterial("fixture-material").setBaseColorFactor([0.8, 0.9, 1, 1]);
  material.setExtras({ semantic: "fixture-material" });
  primitive.setMaterial(material).setExtras({ semantic: "fixture-primitive" });
  const mesh = document.createMesh("fixture-mesh").setExtras({ semantic: "fixture-mesh" }).addPrimitive(primitive);
  const node = document.createNode("fixture-node").setMesh(mesh);
  node.setExtras({ featureId: 101 });
  document.createScene("fixture-scene").setExtras({ semantic: "fixture-scene" }).addChild(node);
  const io: NodeIO = createIO();
	await writeFile(join(root, "_build", "assets", "prototypes", "scene-relative", "fixture.glb"), await io.writeBinary(document));


  await mkdir(join(root, "content"), {recursive:true});
  await writeFile(join(root, "content/fixture.glb"), await io.writeBinary(document));
  await writeJSON(join(root,"tileset.json"),{asset:{version:"1.1"},geometricError:0,root:{boundingVolume:{sphere:[0,0,0,100]},geometricError:0,content:{uri:"content/fixture.glb"}}});
  await writeJSON(join(root,"_build/prototypes.json"),[{
    prototypeId:"prototype-000001", prototypeKey:"obj:fixture.obj", name:"fixture",
    assetKey:"scene-relative/fixture",assetPath:"_build/assets/prototypes/scene-relative/fixture",
    sourcePath:"fixture.obj",role:"scene-relative",baseGLB:"_build/assets/prototypes/scene-relative/fixture.glb",lods:[]
  }]);
  await writeFile(join(root,"_build/instances.jsonl"),"");
  await writeJSON(join(root,"objects/index.json"),{schema:"model-optimizer.tileset-objects",version:1,objects:[]});
  await writeJSON(join(root,"_build/spatial-layout.json"),{});
  const files=["tileset.json","content/fixture.glb","_build/prototypes.json","_build/instances.jsonl","objects/index.json","_build/spatial-layout.json","_build/assets/prototypes/scene-relative/fixture.glb"];
  await writeJSON(join(root,"_build/build-manifest.json"),{
    schema:"model-optimizer.lod-input",version:1,sceneId:"line-a",sourceHash:"source",
    prototypeManifest:"_build/prototypes.json",instanceManifest:"_build/instances.jsonl",
    objectIndex:"objects/index.json",layout:"_build/spatial-layout.json",
    files:await Promise.all(files.map(async path=>({path,sha256:await sha256File(join(root,path))})))
  });
  return root;
}

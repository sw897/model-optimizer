import { Accessor, Document, Primitive } from "@gltf-transform/core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIO, readGLB } from "../src/glb.js";
import { hashDirectory } from "../src/fs-utils.js";
import { runOptimizer } from "../src/optimizer.js";

const temporaryRoots: string[] = [];
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("model-opt worker", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("optimizes a published scene with Meshopt and KTX2 while preserving scene metadata", async () => {
    const input = await createPublishedFixture();
    const output = join(input, "..", "web-scene");
    temporaryRoots.push(input, output);

    const report = await runOptimizer({ input, output, json: false, verbose: false, help: false, version: false });
    expect(report.status).toBe("succeeded");
    expect(report.assets).toHaveLength(1);
    expect(report.assets[0]?.textureCompression).toBe("ktx2");
    expect(report.assets[0]?.geometryCompression).toBe("meshopt");

    const scene = JSON.parse(await readFile(join(output, "scene.json"), "utf8")) as {
      sceneHash: string;
      geometryCompression: string;
      textureCompression: string;
      optimizationManifest: string;
      reportPath: string;
    };
    expect(scene.sceneHash).toBe(report.outputSceneHash);
    expect(scene.geometryCompression).toBe("meshopt");
    expect(scene.textureCompression).toBe("ktx2");
    expect(scene.optimizationManifest).toBe("optimization-manifest.json");
    expect(scene.reportPath).toBe("optimization-report.json");

    const manifest = JSON.parse(await readFile(join(output, "optimization-manifest.json"), "utf8")) as {
      schema: string;
      profile: string;
      prototypes: Array<{ assets: Array<{ level: number; outputSha256: string }> }>;
    };
    expect(manifest.schema).toBe("model-optimizer.optimization-manifest");
    expect(manifest.profile).toBe("web-v1");
    expect(manifest.prototypes[0]?.assets[0]?.level).toBe(0);
    expect(manifest.prototypes[0]?.assets[0]?.outputSha256).toHaveLength(64);

    const prototypes = JSON.parse(await readFile(join(output, "prototypes.json"), "utf8")) as Array<{
      contentSha256: string;
      lods: Array<{ level: number; sha256: string; inputSha256: string }>;
    }>;
    expect(prototypes[0]?.contentSha256).toHaveLength(64);
    expect(prototypes[0]?.lods[0]?.sha256).toBe(prototypes[0]?.contentSha256);
    expect(prototypes[0]?.lods[0]?.inputSha256).toBe(prototypes[0]?.contentSha256);
    const optimizedDocument = await readGLB(join(output, "prototypes", "prototype-000001", "lod0.glb"));
    expect(optimizedDocument.hasExtension("EXT_meshopt_compression")).toBe(true);
    expect(optimizedDocument.hasExtension("KHR_texture_basisu")).toBe(true);
    optimizedDocument.getRoot().dispose();
    expect(await hashDirectory(output, ["scene.json", "build-report.json", "merge-report.json", "source-manifest.json", "optimization-report.json"]))
      .toBe(scene.sceneHash);
  });

  it("rejects a scene whose prototype LOD range does not match scene.json", async () => {
    const input = await createPublishedFixture();
    const output = join(input, "..", "invalid-web-scene");
    temporaryRoots.push(input, output);

    const prototypesPath = join(input, "prototypes.json");
    const prototypes = JSON.parse(await readFile(prototypesPath, "utf8")) as Array<{
      lods: Array<{ level: number; path: string; geometricErrorMeters: number; method: string }>;
    }>;
    prototypes[0]?.lods.push({
      level: 1,
      path: "prototypes/prototype-000001/lod0.glb",
      geometricErrorMeters: 1,
      method: "meshopt-simplify",
    });
    await writeFile(prototypesPath, `${JSON.stringify(prototypes)}\n`);

    const scenePath = join(input, "scene.json");
    const scene = JSON.parse(await readFile(scenePath, "utf8")) as { sceneHash: string };
    scene.sceneHash = await hashDirectory(input, ["scene.json", "build-report.json", "merge-report.json", "source-manifest.json"]);
    await writeFile(scenePath, `${JSON.stringify(scene)}\n`);

    await expect(runOptimizer({ input, output, json: false, verbose: false, help: false, version: false }))
      .rejects.toThrow("LOD level mismatch");
  });
});

async function createPublishedFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "model-optimizer-fixture-"));
  const prototypeRoot = join(root, "prototypes", "prototype-000001");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(prototypeRoot, { recursive: true });

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
  const texture = document.createTexture("fixture-albedo").setMimeType("image/png").setImage(ONE_PIXEL_PNG);
  const material = document.createMaterial("fixture-material").setBaseColorTexture(texture);
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(indices).setMaterial(material);
  const mesh = document.createMesh("fixture-mesh").addPrimitive(primitive);
  document.createScene("fixture-scene").addChild(document.createNode("fixture-node").setMesh(mesh));
  await writeFile(join(prototypeRoot, "lod0.glb"), await createIO().writeBinary(document));

  await writeFile(join(root, "source-manifest.json"), "{}\n");
  await writeFile(join(root, "instances.jsonl"), "");
  await writeFile(join(root, "object-index.json"), "[]\n");
  await writeFile(
    join(root, "prototypes.json"),
    JSON.stringify([
      {
        prototypeId: "prototype-000001",
        prototypeKey: "fixture",
        canonicalGLB: "prototypes/prototype-000001/lod0.glb",
        lods: [{ level: 0, path: "prototypes/prototype-000001/lod0.glb", geometricErrorMeters: 0, method: "canonical" }],
      },
    ]),
  );
  const scene = {
    schema: "model-optimizer.model-scene",
    version: 1,
    buildStage: "published",
    sceneHash: "pending",
    canonicalAxis: "obj-z-up-to-gltf-y-up",
    prototypeManifest: "prototypes.json",
    instanceManifest: "instances.jsonl",
    objectIndex: "object-index.json",
    pages: [],
    lodLevels: 0,
    geometryCompression: "none",
    textureCompression: "none",
  };
  scene.sceneHash = await hashDirectory(root, ["scene.json", "build-report.json", "merge-report.json", "source-manifest.json"]);
  await writeFile(join(root, "scene.json"), JSON.stringify(scene));
  return root;
}

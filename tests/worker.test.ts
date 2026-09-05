import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCLI } from "../src/cli.js";
import { createIO } from "../src/glb.js";
import { hashDirectory } from "../src/fs-utils.js";
import { runWorker } from "../src/worker.js";

const temporaryRoots: string[] = [];

describe("model-lod worker", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("parses the standalone worker interface", () => {
    expect(parseCLI(["--input", "in", "--output", "out", "--max-level", "0", "--preset", "lod0-only"]).maxLevel).toBe(0);
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
      baseSceneHash: string;
      prototypes: Array<{ lods: Array<{ level: number; path: string; sha256: string; method: string }> }>;
    };
    expect(manifest.schema).toBe("model-optimizer.lod-manifest");
    const inputScene = JSON.parse(await readFile(join(input, "scene.json"), "utf8")) as { sceneHash: string };
    expect(manifest.baseSceneHash).toBe(inputScene.sceneHash);
    expect(manifest.prototypes[0]?.lods[0]?.level).toBe(1);
    expect(manifest.prototypes[0]?.lods[0]?.method).toBe("meshopt-simplify");
    expect(manifest.prototypes[0]?.lods[0]?.sha256).toHaveLength(64);
    expect(await readFile(join(output, "prototypes", "prototype-000001", "lod1.glb"))).toHaveLength(
      report.prototypes[0]?.lods[0]?.outputBytes ?? 0,
    );
    expect(await readFile(join(input, "scene.json"), "utf8")).toContain('"buildStage":"canonical"');

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
    expect(await readFile(join(outputRepeat, "prototypes", "prototype-000001", "lod1.glb"))).toEqual(
      await readFile(join(output, "prototypes", "prototype-000001", "lod1.glb")),
    );
    expect(await readFile(join(outputRepeat, "lod-manifest.json"))).toEqual(
      await readFile(join(output, "lod-manifest.json")),
    );
  });

  it("supports the compliance-only max-level 0 path", async () => {
    const input = await createCanonicalFixture();
    const output = join(input, "..", "stage2-lod0");
    const report = await runWorker({
      input,
      output,
      preset: "lod0-only",
      maxLevel: 0,
      json: false,
      verbose: false,
      resume: false,
      help: false,
      version: false,
    });
    temporaryRoots.push(input, output);
    expect(report.prototypes[0]?.status).toBe("lod0-only");
    await expect(readFile(join(output, "prototypes", "prototype-000001", "lod1.glb"))).rejects.toThrow();
    const manifest = JSON.parse(await readFile(join(output, "lod-manifest.json"), "utf8")) as {
      prototypes: Array<{ lods: unknown[] }>;
    };
    expect(manifest.prototypes[0]?.lods).toHaveLength(0);
  });
});

async function createCanonicalFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "model-lod-fixture-"));
  const prototypeRoot = join(root, "prototypes", "prototype-000001");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(prototypeRoot, { recursive: true });

  const document = new Document();
  const buffer = document.createBuffer();
  const width = 12;
  const positions: number[] = [];
  const indices: number[] = [];
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
  const positionAccessor = document
    .createAccessor("POSITION")
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const indexAccessor = document
    .createAccessor("INDICES")
    .setType(Accessor.Type.SCALAR)
    .setArray(new Uint32Array(indices))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positionAccessor).setIndices(indexAccessor);
  const mesh = document.createMesh("fixture-mesh").addPrimitive(primitive);
  document.createNode("fixture-node").setMesh(mesh);
  document.createScene("fixture-scene").addChild(document.getRoot().listNodes()[0]!);
  const io: NodeIO = createIO();
  await writeFile(join(prototypeRoot, "lod0.glb"), await io.writeBinary(document));

  await writeFile(
    join(root, "scene.json"),
    JSON.stringify({
      schema: "model-optimizer.model-scene",
      version: 1,
      buildStage: "canonical",
      sceneHash: "pending",
      canonicalAxis: "obj-z-up-to-gltf-y-up",
      prototypeManifest: "prototypes.json",
      instanceManifest: "instances.jsonl",
      objectIndex: "object-index.json",
      pages: [],
      lodLevels: 0,
    }),
  );
  await writeFile(join(root, "source-manifest.json"), "{}\n");
  await writeFile(
    join(root, "prototypes.json"),
    JSON.stringify([
      {
        prototypeId: "prototype-000001",
        prototypeKey: "fixture",
        sourcePath: "fixture.obj",
        role: "prototype-local",
        canonicalGLB: "prototypes/prototype-000001/lod0.glb",
        lods: [{ level: 0, path: "prototypes/prototype-000001/lod0.glb", geometricErrorMeters: 0, method: "canonical" }],
      },
    ]),
  );
  await writeFile(join(root, "instances.jsonl"), "");
  await writeFile(join(root, "object-index.json"), "[]\n");
  const scene = JSON.parse(await readFile(join(root, "scene.json"), "utf8")) as Record<string, unknown>;
  scene.sceneHash = await hashDirectory(root, ["scene.json", "build-report.json", "merge-report.json", "source-manifest.json"]);
  await writeFile(join(root, "scene.json"), JSON.stringify(scene));
  return root;
}

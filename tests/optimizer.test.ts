import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { runOptimizer } from "../src/optimizer.js";
import { loadResourceGraph, gltfBuffers, resourcePath } from "../src/resource-graph.js";
import { writeJSON } from "../src/fs-utils.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
const options = (input: string, output: string) => ({input,output,json:false,verbose:false,help:false,version:false});

describe("standard tileset optimizer", () => {
  it("shares external geometry, preserves per-instance features and exact positions, and strips build inputs", async () => {
    const {root,input} = await fixture();
    const output = join(root,"web");
    const encode = vi.spyOn(MeshoptEncoder, "encodeGltfBuffer");
    const report = await runOptimizer(options(input,output));
    expect(encode).toHaveBeenCalledTimes(6);
    encode.mockRestore();
    expect(report.status).toBe("succeeded");
    expect(report.geometryResources).toBe(3);
    expect(report.assets).toHaveLength(2);
    expect(report.compressedViews).toBe(8);
    expect(report.featureValidation).toEqual({ assets: 2, featureSets: 2, instances: 4, propertyRows: 4 });
    expect(report.preservedExtensions).toEqual(["EXT_instance_features"]);
    const graph = await loadResourceGraph(output);
    const a = graph.documents.get("content/a.gltf")!, b = graph.documents.get("content/b.gltf")!;
    expect(a.buffers[0].uri).toBe(b.buffers[0].uri);
    expect(a.nodes[0].extensions.EXT_instance_features).toEqual({
      featureIds:[{attribute:0,propertyTable:0,featureCount:2}]
    });
    expect(a.extensions.EXT_structural_metadata.propertyTables[0].count).toBe(2);
    const buffers = await gltfBuffers(graph,"content/a.gltf",a);
    const view = a.bufferViews[0], ext = view.extensions.EXT_meshopt_compression;
    const decoded = Buffer.alloc(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(decoded,ext.count,ext.byteStride,buffers[ext.buffer]!.subarray(ext.byteOffset,ext.byteOffset+ext.byteLength),ext.mode);
    expect(decoded).toEqual(Buffer.from(new Float32Array([0,0,0,1,0,0,0,1,0]).buffer));
    expect(await readFile(join(output,"objects/index.json"),"utf8")).toContain("line-a/tower/1");
    expect(JSON.parse(await readFile(join(output,"_pack/catalog.json"),"utf8")).sceneId).toBe("line-a");
    await expect(readFile(join(output,"_build/build-manifest.json"))).rejects.toThrow();
    await expect(readFile(join(output,"scene.json"))).rejects.toThrow();
    const again = join(root,"repeat");
    await runOptimizer(options(input,again));
    expect((await loadResourceGraph(again)).hash).toBe(graph.hash);
  });
  it("encodes one shared texture once and creates distinct color/data variants", async () => {
    const {root,input} = await fixture(true);
    const report = await runOptimizer(options(input,join(root,"web")));
    expect(report.textureResources).toBe(2);
    const graph = await loadResourceGraph(join(root,"web"));
    const a=graph.documents.get("content/a.gltf")!, b=graph.documents.get("content/b.gltf")!;
    expect(a.images[0].uri).toBe(b.images[0].uri);
    expect(a.images[0].uri).not.toBe(a.images[1].uri);
    expect(a.extensionsRequired).toContain("KHR_texture_basisu");
    expect(a.materials[0].pbrMetallicRoughness.baseColorTexture.index).not.toBe(a.materials[0].normalTexture.index);
  }, 30000);
  it.each([
    { codec: "EXT_texture_webp", format: "webp", required: false, protected: false },
    { codec: "EXT_texture_avif", format: "avif", required: true, protected: false },
    { codec: "EXT_texture_webp", format: "webp", required: true, protected: true },
  ] as const)("rewrites $codec sources and declarations (protected=$protected)", async testCase => {
    const { root, input } = await fixture(true);
    const image = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 80, g: 160, b: 240, alpha: 1 } } }).toFormat(testCase.format).toBuffer();
    await writeFile(join(input, `resources/preferred.${testCase.format}`), image);
    const source = join(input, "content/a.gltf");
    const gltf = JSON.parse(await readFile(source, "utf8"));
    gltf.images.push({ uri: `../resources/preferred.${testCase.format}`, mimeType: `image/${testCase.format}` });
    gltf.textures[0] = { sampler: 0, extras: { identity: "porcelain" }, extensions: { [testCase.codec]: { source: 1 } }, ...(testCase.required ? {} : { source: 0 }) };
    gltf.samplers = [{ wrapS: 33071, wrapT: 33071 }];
    delete gltf.materials[0].normalTexture;
    gltf.extensionsUsed.push(testCase.codec);
    if (testCase.required) gltf.extensionsRequired.push(testCase.codec);
    if (testCase.protected) {
      gltf.extensionsUsed.push("EXT_mesh_features");
      gltf.meshes[0].primitives[0].extensions = { EXT_mesh_features: { featureIds: [{ featureCount: 2, propertyTable: 0, texture: { index: 0, channels: [0] } }] } };
    }
    await writeJSON(source, gltf);
    const output = join(root, "web");
    expect((await runOptimizer(options(input, output))).status).toBe("succeeded");
    const graph = await loadResourceGraph(output), result = graph.documents.get("content/a.gltf")!;
    const texture = result.textures[result.materials[0].pbrMetallicRoughness.baseColorTexture.index];
    expect(texture).toMatchObject({ sampler: 0, extras: { identity: "porcelain" } });
    expect(texture.source).toBeUndefined();
    expect(Object.keys(texture.extensions)).toEqual(["KHR_texture_basisu"]);
    const materialImage = result.images[texture.extensions.KHR_texture_basisu.source];
    expect(materialImage.mimeType).toBe("image/ktx2");
    expect(materialImage.uri).toContain(`preferred.${testCase.format}/`);
    expect(result.extensionsRequired).toContain("KHR_texture_basisu");
    if (testCase.protected) {
      expect(result.extensionsUsed).toContain(testCase.codec);
      expect(result.extensionsRequired).toContain(testCase.codec);
      const featureTexture = result.textures[result.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0].texture.index];
      const featureImage = result.images[featureTexture.extensions[testCase.codec].source];
      expect(await readFile(join(output, resourcePath("content/a.gltf", featureImage.uri)))).toEqual(image);
    } else {
      expect(result.images).toHaveLength(1);
      expect(result.extensionsUsed).not.toContain(testCase.codec);
      expect(result.extensionsRequired).not.toContain(testCase.codec);
    }
  }, 30000);
  it("rejects remote dependencies, cycles and symlink escapes before publishing", async () => {
    const {root,input} = await fixture();
    const tileset=JSON.parse(await readFile(join(input,"tileset.json"),"utf8"));
    tileset.root.children[0].content.uri="https://example.invalid/model.glb";
    await writeJSON(join(input,"tileset.json"),tileset);
    await expect(runOptimizer(options(input,join(root,"web")))).rejects.toThrow("unsupported external");
    tileset.root.children[0].content.uri="tileset.json";
    await writeJSON(join(input,"tileset.json"),tileset);
    await expect(loadResourceGraph(input)).rejects.toThrow("cyclic");
    tileset.root.children[0].content.uri="outside.gltf";
    await writeJSON(join(input,"tileset.json"),tileset);
    await writeFile(join(root,"outside.gltf"),"{}");
    await symlink(join(root,"outside.gltf"),join(input,"outside.gltf"));
    await expect(loadResourceGraph(input)).rejects.toThrow("symlink");
  });
  it("preserves feature-ID texture bytes while optimizing material variants", async () => {
    const {root,input} = await fixture(true);
    const path=join(input,"content/a.gltf");
    const gltf=JSON.parse(await readFile(path,"utf8"));
    gltf.extensionsUsed.push("EXT_mesh_features");
    gltf.meshes[0].primitives[0].extensions={EXT_mesh_features:{featureIds:[{featureCount:2,propertyTable:0,texture:{index:0,channels:[0]}}]}};
    await writeJSON(path,gltf);
    const output=join(root,"web"); await runOptimizer(options(input,output));
    const graph=await loadResourceGraph(output), result=graph.documents.get("content/a.gltf")!;
    const featureTexture=result.textures[result.meshes[0].primitives[0].extensions.EXT_mesh_features.featureIds[0].texture.index];
    const image=result.images[featureTexture.source];
    expect(await readFile(join(output,resourcePath("content/a.gltf",image.uri)))).toEqual(await readFile(join(input,"resources/porcelain.png")));
    expect(result.materials[0].pbrMetallicRoughness.baseColorTexture.index).not.toBe(0);
  });
  it("includes business-index changes in immutable release identity", async () => {
    const {root,input}=await fixture();
    const first=await runOptimizer(options(input,join(root,"web")));
    const index=JSON.parse(await readFile(join(input,"objects/index.json"),"utf8"));
    index.objects[0].status="inspected"; await writeJSON(join(input,"objects/index.json"),index);
    const second=await runOptimizer(options(input,join(root,"web-2")));
    expect(first.releaseId).not.toBe(second.releaseId);
    expect(JSON.parse(await readFile(join(root,"web-2/objects/index.json"),"utf8")).objects[0].status).toBe("inspected");
  });
  it("leaves no publication after a malformed accessor resource fails", async () => {
    const {root,input} = await fixture();
    const path=join(input,"content/a.gltf");
    const gltf=JSON.parse(await readFile(path,"utf8")); gltf.bufferViews[0].byteLength=999999;
    await writeJSON(path,gltf);
    await expect(runOptimizer(options(input,join(root,"web")))).rejects.toThrow("invalid bufferView");
    await expect(readFile(join(root,"web/tileset.json"))).rejects.toThrow();
  });
  it("rejects feature IDs outside their property table before publishing", async () => {
    const {root,input} = await fixture();
    const source = join(input,"content/a.gltf");
    const gltf = JSON.parse(await readFile(source,"utf8"));
    gltf.nodes[0].extensions.EXT_instance_features.featureIds[0].featureCount = 1;
    await writeJSON(source,gltf);
    await expect(runOptimizer(options(input,join(root,"web")))).rejects.toThrow("exceeds featureCount");
    await expect(readFile(join(root,"web/tileset.json"))).rejects.toThrow();
  });
  it("rejects corrupt property-table string offsets", async () => {
    const {root,input} = await fixture();
    const source = join(input,"content/a.bin");
    const bytes = await readFile(source); bytes.writeUInt32LE(9999,44);
    await writeFile(source,bytes);
    await expect(runOptimizer(options(input,join(root,"web")))).rejects.toThrow("string offsets out of range");
  });
  it("keeps unknown extension warnings while suppressing known preserved instance features", async () => {
    const {root,input} = await fixture();
    const source = join(input,"content/a.gltf");
    const gltf = JSON.parse(await readFile(source,"utf8"));
    gltf.extensionsUsed.push("VENDOR_unknown"); gltf.extensions.VENDOR_unknown={value:1};
    await writeJSON(source,gltf);
    const warnings = vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    try {
      await runOptimizer(options(input,join(root,"web")));
      expect(warnings.mock.calls.flat().join("\n")).toContain("VENDOR_unknown");
      expect(warnings.mock.calls.flat().join("\n")).not.toContain("EXT_instance_features");
    } finally { warnings.mockRestore(); }
  });
  it("gives changed immutable payloads a new resource URL", async () => {
    const {root,input} = await fixture();
    const oldPath = "resources/scenes/old/content/a.gltf";
    const gltf = JSON.parse(await readFile(join(input,"content/a.gltf"),"utf8"));
    gltf.buffers[0].uri = "../../../insulator.bin";
    gltf.buffers[1].uri = "../../../../content/a.bin";
    await writeJSON(join(input,oldPath),gltf);
    const tile = JSON.parse(await readFile(join(input,"tileset.json"),"utf8"));
    tile.root.children[0].content.uri = oldPath;
    await writeJSON(join(input,"tileset.json"),tile);
    const index = JSON.parse(await readFile(join(input,"objects/index.json"),"utf8"));
    index.objects[0].contents[0] = oldPath;
    await writeJSON(join(input,"objects/index.json"),index);
    const report = await runOptimizer(options(input,join(root,"web")));
    const target = `resources/scenes/${report.releaseId}/old/content/a.gltf`;
    expect((await loadResourceGraph(join(root,"web"))).gltfs.has(target)).toBe(true);
    await expect(readFile(join(root,"web",oldPath))).rejects.toThrow();
    const rewritten = JSON.parse(await readFile(join(root,"web/objects/index.json"),"utf8"));
    expect(rewritten.objects[0].contents[0]).toBe(target);
  });
});

async function fixture(texture=false): Promise<{root:string;input:string}> {
  const root=await mkdtemp(join(tmpdir(),"standard-opt-")); roots.push(root);
  const input=join(root,"input");
  await mkdir(join(input,"content"),{recursive:true});
  await mkdir(join(input,"resources"),{recursive:true});
  const geometry=Buffer.concat([Buffer.from(new Float32Array([0,0,0,1,0,0,0,1,0]).buffer),Buffer.from(new Uint16Array([0,1,2]).buffer)]);
  await writeFile(join(input,"resources/insulator.bin"),geometry);
  if(texture) await writeFile(join(input,"resources/porcelain.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64"));
  for(const name of ["a","b"]) {
    const translations=Buffer.from(new Float32Array([0,0,0,10,0,0]).buffer);
    const ids=Buffer.from(new Uint32Array([1,0]).buffer);
    const values=Buffer.from(name+"1"+name+"2");
    const offsets=Buffer.from(new Uint32Array([0,2,4]).buffer);
    const instances=Buffer.concat([translations,ids,values,offsets]);
    await writeFile(join(input,"content",name+".bin"),instances);
    const gltf:any={
      asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],
      extensionsUsed:["EXT_mesh_gpu_instancing","EXT_instance_features","EXT_structural_metadata"],
      extensionsRequired:["EXT_mesh_gpu_instancing"],
      buffers:[{uri:"../resources/insulator.bin",byteLength:geometry.length},{uri:name+".bin",byteLength:instances.length}],
      bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:6},{buffer:1,byteOffset:0,byteLength:24},{buffer:1,byteOffset:24,byteLength:8},{buffer:1,byteOffset:32,byteLength:4},{buffer:1,byteOffset:36,byteLength:12}],
      accessors:[{bufferView:0,componentType:5126,type:"VEC3",count:3,min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5123,type:"SCALAR",count:3},{bufferView:2,componentType:5126,type:"VEC3",count:2},{bufferView:3,componentType:5125,type:"SCALAR",count:2}],
      meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
      nodes:[{mesh:0,extensions:{EXT_mesh_gpu_instancing:{attributes:{TRANSLATION:2,_FEATURE_ID_0:3}},EXT_instance_features:{featureIds:[{attribute:0,propertyTable:0,featureCount:2}]}}}],
      materials:[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1]}}],
      extensions:{EXT_structural_metadata:{schema:{classes:{component:{properties:{objectKey:{type:"STRING"}}}}},propertyTables:[{class:"component",count:2,properties:{objectKey:{values:4,stringOffsets:5}}}]}}
    };
    if(texture) {gltf.images=[{uri:"../resources/porcelain.png"}];gltf.textures=[{source:0}];gltf.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};gltf.materials[0].normalTexture={index:0};}
    await writeJSON(join(input,"content",name+".gltf"),gltf);
  }
  await writeJSON(join(input,"tileset.json"),{asset:{version:"1.1",extras:{sceneId:"line-a",catalog:"_pack/catalog.json",objectIndex:"objects/index.json"}},geometricError:100,root:{boundingVolume:{box:[0,0,0,20,0,0,0,20,0,0,0,20]},geometricError:10,children:["a","b"].map(name=>({boundingVolume:{box:[0,0,0,20,0,0,0,20,0,0,0,20]},geometricError:0,content:{uri:"content/"+name+".gltf"}}))}});
  await writeJSON(join(input,"_build/build-manifest.json"),{schema:"model-optimizer.lod-input",version:1,sceneId:"line-a"});
  await writeJSON(join(input,"_pack/catalog.json"),{schema:"model-optimizer.tileset-catalog",version:1,sceneId:"line-a",root:"tileset.json",objectIndex:"objects/index.json",nodes:[{sceneId:"line-a",parentId:"",payloadPath:"tileset.json",sourceHash:"original"}]});
  await writeJSON(join(input,"objects/index.json"),{schema:"model-optimizer.tileset-objects",version:1,objects:[{sceneId:"line-a",objectId:"tower/1",objectKey:"line-a/tower/1",contents:["content/a.gltf","content/b.gltf"],componentCount:2}]});
  return {root,input};
}

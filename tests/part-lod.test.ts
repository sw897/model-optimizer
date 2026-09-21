import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { simplifyGLB } from "../src/glb.js";
import { encodePartGLB, simplifyPartGLB } from "../src/part-lod.js";
import { parseGLB, type JSONObject } from "../src/resource-graph.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const level = { level: 1, ratio: .35, maxErrorMeters: .08, lockBorder: true };

function fixture(): Buffer {
  const json: JSONObject = { asset: { version: "2.0" }, buffers: [{byteLength:0}], bufferViews: [], accessors: [],
    nodes: [{mesh:0,name:"tower"}], scenes:[{nodes:[0]}], scene:0,
    materials:[{name:"steel",pbrMetallicRoughness:{baseColorFactor:[.4,.4,.4,1]}}],
    extensionsUsed:["EXT_mesh_features","EXT_structural_metadata"],
    extensions:{EXT_structural_metadata:{schema:{id:"model_features_v2",classes:{prototype_parts:{properties:{partId:{type:"STRING"},displayName:{type:"STRING"},sourceName:{type:"STRING"}}}}},propertyTables:[{class:"prototype_parts",count:2,properties:{}}]}},
    meshes:[{primitives:[]}] };
  const buffers: Buffer[] = []; let length = 0;
  const view = (bytes:Buffer):number => { const pad=(8-length%8)%8; buffers.push(Buffer.alloc(pad),bytes); length+=pad; const index=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:length,byteLength:bytes.length}); length+=bytes.length;return index; };
  const accessor=(values:number[],type:string,componentType:number):number=>{const bytes=Buffer.alloc(values.length*4);values.forEach((v,i)=>componentType===5126?bytes.writeFloatLE(v,i*4):bytes.writeUInt32LE(v,i*4));const index=json.accessors.length;json.accessors.push({bufferView:view(bytes),type,componentType,count:values.length/(type==='VEC3'?3:type==='VEC2'?2:1)});return index;};
  for (const [name,values] of Object.entries({partId:["body","tiny"],displayName:["Tower body","Small fitting"],sourceName:["body.obj","tiny.obj"]})) {
    const offsets=Buffer.alloc(12); offsets.writeUInt32LE(Buffer.byteLength(values[0]!),4);offsets.writeUInt32LE(Buffer.byteLength(values.join('')),8);
    json.extensions.EXT_structural_metadata.propertyTables[0].properties[name]={values:view(Buffer.from(values.join(''))),stringOffsets:view(offsets)};
  }
  for (let part=0;part<2;part++) {
    const positions:number[]=[],uv:number[]=[],indices:number[]=[];
    if (!part) {
      for(let y=0;y<=10;y++) for(let x=0;x<=10;x++){positions.push(x/10,y/10,0);uv.push(x/10,y/10);}
      for(let y=0;y<10;y++) for(let x=0;x<10;x++){const a=y*11+x;indices.push(a,a+1,a+11,a+1,a+12,a+11);}
    } else {positions.push(2,0,0,2.01,0,0,2,.01,0);uv.push(0,0,1,0,0,1);indices.push(0,1,2);}
    json.meshes[0].primitives.push({material:0,indices:accessor(indices,"SCALAR",5125),attributes:{POSITION:accessor(positions,"VEC3",5126),TEXCOORD_0:accessor(uv,"VEC2",5126),_FEATURE_ID_1:accessor(Array(positions.length/3).fill(part),"SCALAR",5126)},extensions:{EXT_mesh_features:{featureIds:[{attribute:1,featureCount:2,propertyTable:0,label:"part"}]}},extras:{modelPart:{partId:part?"tiny":"body"}}});
  }
  json.buffers[0].byteLength=length;
  return encodePartGLB(json,Buffer.concat(buffers));
}
function values(glb: ReturnType<typeof parseGLB>, id:number):number[] {
  const a=glb.json.accessors[id],v=glb.json.bufferViews[a.bufferView],n=a.type==='VEC3'?3:a.type==='VEC2'?2:1;
  return Array.from({length:a.count*n},(_,i)=>a.componentType===5126?glb.binary!.readFloatLE(v.byteOffset+i*4):glb.binary!.readUInt32LE(v.byteOffset+i*4));
}
it("reduces a part while retaining tiny parts, attributes, metadata and deterministic output",async()=>{
  const bytes=fixture(),before=parseGLB(bytes,'before');
  const result=await simplifyPartGLB(bytes,level),after=parseGLB(result.bytes,'after');
  expect(result.stats.triangleCount).toBeLessThan(result.sourceStats.triangleCount);
  expect(result.stats.vertexCount).toBeLessThan(result.sourceStats.vertexCount);
  expect(result.error).toBeLessThanOrEqual(level.maxErrorMeters);
  expect(after.json.extensions).toEqual(before.json.extensions);
  expect(after.json.nodes).toEqual(before.json.nodes);expect(after.json.materials).toEqual(before.json.materials);
  for(let n=0;n<2;n++) {
    const src=before.json.meshes[0].primitives[n],dst=after.json.meshes[0].primitives[n];
    expect(dst.extras).toEqual(src.extras);expect(dst.extensions).toEqual(src.extensions);
    expect(new Set(values(after,dst.attributes._FEATURE_ID_1))).toEqual(new Set([n]));
    const positions=values(after,dst.attributes.POSITION),uv=values(after,dst.attributes.TEXCOORD_0);
    const originalPositions=values(before,src.attributes.POSITION),originalUV=values(before,src.attributes.TEXCOORD_0);
    for(let i=0;i<positions.length/3;i++) {
      const old=Array.from({length:originalPositions.length/3},(_,k)=>k).find(k=>originalPositions.slice(k*3,k*3+3).every((v,j)=>v===positions[i*3+j]));
      expect(old).toBeDefined();expect(uv.slice(i*2,i*2+2)).toEqual(originalUV.slice(old!*2,old!*2+2));
    }
    if(n===1) expect(values(after,dst.indices)).toHaveLength(3);
  }
  for(let i=0;i<6;i++) {
    const a=before.json.bufferViews[i],b=after.json.bufferViews[i];
    expect(after.binary!.subarray(b.byteOffset,b.byteOffset+b.byteLength)).toEqual(before.binary!.subarray(a.byteOffset,a.byteOffset+a.byteLength));
  }
  expect((await simplifyPartGLB(bytes,level)).bytes).toEqual(result.bytes);
});
it("passes public simplification and feature validation for both LOD levels",async()=>{
  const root=await mkdtemp(join(tmpdir(),'part-lod-'));roots.push(root);const input=join(root,'source.glb');const bytes=fixture();await writeFile(input,bytes);
  const report=await simplifyGLB(input,n=>join(root,`lod${n}.glb`),[level,{...level,level:2,ratio:.15,maxErrorMeters:.3}]);
  expect(report.levels).toHaveLength(2);expect(report.levels.every(l=>l.outputTriangles<l.inputTriangles)).toBe(true);expect(await readFile(input)).toEqual(bytes);
});
it.each(['mixed','scaled','alias','sparse','shared','external','animation'])('preserves base-only for unsafe %s layouts',async(kind)=>{
  const glb=parseGLB(fixture(),'fixture'),json=glb.json,p=json.meshes[0].primitives[0];
  if(kind==='mixed'){const v=json.bufferViews[json.accessors[p.attributes._FEATURE_ID_1].bufferView];glb.binary!.writeFloatLE(1,v.byteOffset);}
  if(kind==='scaled')json.nodes[0].scale=[2,1,1];
  if(kind==='alias')json.images=[{bufferView:json.accessors[p.attributes.POSITION].bufferView,mimeType:'image/png'}];
  if(kind==='sparse')json.accessors[p.attributes.POSITION].sparse={count:1};
  if(kind==='shared')json.meshes[0].primitives.push(structuredClone(p));
  if(kind==='external')json.buffers[0].uri='other.bin';
  if(kind==='animation')json.animations=[{}];
  await expect(simplifyPartGLB(encodePartGLB(json,glb.binary!),level)).rejects.toThrow('part feature ownership/survival');
});

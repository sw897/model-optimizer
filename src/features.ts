import { MeshoptDecoder } from "meshoptimizer";
import { gltfBuffers, type JSONObject, type ResourceGraph } from "./resource-graph.js";
import { componentKey } from "./publication-index.js";

export interface FeatureValidation { assets: number; featureSets: number; instances: number; propertyRows: number }

export async function validateFeatureMetadata(graph: ResourceGraph): Promise<FeatureValidation> {
  const result = { assets: 0, featureSets: 0, instances: 0, propertyRows: 0 };
  const objectIndexPath = graph.documents.get(graph.entry)?.asset?.extras?.objectIndex;
  const objectIndex = graph.documents.get(objectIndexPath)?.objects as JSONObject[] | undefined;
  const objects = new Map((objectIndex ?? []).map(object => [object.objectKey, object]));
  const componentIndexPath = graph.documents.get(graph.entry)?.asset?.extras?.componentIndex;
  const componentIndex = graph.documents.get(componentIndexPath);
  const components = new Map<string, JSONObject>();
  const expectedFeatures = new Set<string>();
  for (const info of componentIndex?.shards ?? []) for (const record of graph.documents.get(info.path)!.components) {
    components.set(componentKey(record), record);
    for (const content of record.contents) expectedFeatures.add(JSON.stringify([componentKey(record), content.path]));
  }
  await MeshoptDecoder.ready;
  for (const name of graph.gltfs) {
    const doc = graph.documents.get(name)!;
    if (!(doc.extensionsUsed ?? []).some((value: string) => ["EXT_instance_features", "EXT_mesh_features", "EXT_structural_metadata"].includes(value))) continue;
    const buffers = await gltfBuffers(graph, name, doc);
    const views = new Map<number, Buffer>();
    const view = (index: number): Buffer => {
      if (views.has(index)) return views.get(index)!;
      const value = doc.bufferViews?.[index];
      if (!Number.isInteger(index) || !value) throw new Error(`feature metadata references invalid bufferView in ${name}`);
      const compressed = value.extensions?.EXT_meshopt_compression;
      let bytes: Buffer;
      if (compressed) {
        const source = buffers[compressed.buffer], offset = compressed.byteOffset ?? 0;
        if (!source || offset < 0 || offset + compressed.byteLength > source.length) throw new Error(`feature bufferView compression range invalid in ${name}`);
        bytes = Buffer.alloc(compressed.count * compressed.byteStride);
        MeshoptDecoder.decodeGltfBuffer(bytes, compressed.count, compressed.byteStride, source.subarray(offset, offset + compressed.byteLength), compressed.mode, compressed.filter);
      } else {
        const source = buffers[value.buffer], offset = value.byteOffset ?? 0;
        if (!source || offset < 0 || offset + value.byteLength > source.length) throw new Error(`feature bufferView range invalid in ${name}`);
        bytes = source.subarray(offset, offset + value.byteLength);
      }
      if (bytes.length !== value.byteLength) throw new Error(`feature bufferView byteLength mismatch in ${name}`);
      views.set(index, bytes); return bytes;
    };
    const tables = doc.extensions?.EXT_structural_metadata?.propertyTables ?? [];
    for (const table of tables) {
      if (!Number.isSafeInteger(table.count) || table.count < 1) throw new Error(`invalid property table count in ${name}`);
      const schema = doc.extensions.EXT_structural_metadata.schema;
      const definition = schema?.classes?.[table.class];
      if (schema && !definition) throw new Error(`property table references missing schema class in ${name}`);
      const decodedProperties = new Map<string, string[]>();
      for (const [key, property] of Object.entries(table.properties ?? {}) as [string, JSONObject][]) {
        const type = definition?.properties?.[key];
        if (definition && !type) throw new Error(`property table references missing schema property ${key} in ${name}`);
        const values = view(property.values);
        if (type?.type === "STRING" && !type.array) {
          const offsets = view(property.stringOffsets), offsetType = property.stringOffsetType ?? "UINT32";
          const width = ({ UINT8: 1, UINT16: 2, UINT32: 4, UINT64: 8 } as Record<string, number>)[offsetType];
          if (!width || offsets.length < (table.count + 1) * width) throw new Error(`invalid string offsets for ${key} in ${name}`);
          let previous = 0;
          const decoded: string[] = [];
          for (let i = 0; i <= table.count; i++) {
            const current = width === 8 ? Number(offsets.readBigUInt64LE(i * width)) : offsets.readUIntLE(i * width, width);
            if (!Number.isSafeInteger(current) || current < previous || current > values.length || i === 0 && current !== 0) throw new Error(`string offsets out of range for ${key} in ${name}`);
            if (i) decoded.push(new TextDecoder("utf-8", { fatal: true }).decode(values.subarray(previous, current)));
            previous = current;
          }
          decodedProperties.set(key, decoded);
        }
      }
      if (schema?.id === "model_objects_v1") throw new Error(`obsolete model feature schema in ${name}; rebuild with model_features_v2`);
      if (schema?.id === "model_features_v2") {
        const part = table.class === "prototype_parts";
        if (!part && table.class !== "model_components") throw new Error(`unsupported model feature class in ${name}`);
        const required = part ? ["partId", "displayName", "sourceName"] : ["objectId", "kind", "entityId", "entityType", "componentId", "componentType", "prototypeKey", "displayName", "sourceName", ...(objectIndex ? ["sceneId", "objectKey"] : [])];
        for (const key of required) {
          if (decodedProperties.get(key)?.length !== table.count) throw new Error(`missing model feature metadata ${key} in ${name}`);
        }
        const rowKeys = new Set<string>();
        for (let row = 0; row < table.count; row++) {
          const value = (key: string): string => decodedProperties.get(key)![row]!;
          if (part) {
            if (!value("partId") || rowKeys.has(value("partId"))) throw new Error(`invalid or duplicate part identity in ${name}`);
            rowKeys.add(value("partId")); continue;
          }
          if (["objectId", "kind", "entityId", "entityType", "componentId", "componentType", "prototypeKey"].some(key => !value(key))) throw new Error(`inconsistent object/component identity in ${name}`);
          const key = componentKey({ objectKey: objectIndex ? value("objectKey") : value("objectId"), componentId: value("componentId") });
          if (rowKeys.has(key)) throw new Error(`duplicate component identity in ${name}`);
          rowKeys.add(key);
          if (objectIndex) {
            const object = objects.get(value("objectKey"));
            if (value("objectKey") !== `${value("sceneId")}/${value("objectId")}` || !object || object.sceneId !== value("sceneId") || object.objectId !== value("objectId") || object.kind !== value("kind") || !object.contents.includes(name)) throw new Error(`feature identity does not match object index in ${name}`);
            if (componentIndex) {
              const record = components.get(key);
              if (!record || required.filter(field => field !== "kind").some(field => record[field] !== value(field)) || !record.contents.some((content: JSONObject) => content.path === name)) throw new Error(`feature identity does not match component index in ${name}`);
              expectedFeatures.delete(JSON.stringify([key, name]));
            }
          }
        }
      }
      result.propertyRows += table.count;
    }
    const validateSets = (sets: JSONObject[], attributes: JSONObject, count: number, instanced: boolean): void => {
      if (!Array.isArray(sets) || !sets.length) throw new Error(`missing feature sets in ${name}`);
      for (const set of sets) {
        if (!Number.isSafeInteger(set.featureCount) || set.featureCount < 1) throw new Error(`invalid featureCount in ${name}`);
        if (set.propertyTable !== undefined && (!Number.isInteger(set.propertyTable) || !tables[set.propertyTable] || tables[set.propertyTable].count < set.featureCount)) throw new Error(`feature set references invalid property table in ${name}`);
        if (set.texture !== undefined) {
          if (!doc.textures?.[set.texture.index]) throw new Error(`feature texture index invalid in ${name}`);
          result.featureSets++; continue;
        }
        if (set.attribute === undefined) {
          if (count > set.featureCount) throw new Error(`implicit feature IDs exceed featureCount in ${name}`);
          result.featureSets++; continue;
        }
        const accessor = doc.accessors?.[attributes[`_FEATURE_ID_${set.attribute}`]];
        if (!Number.isInteger(set.attribute) || set.attribute < 0 || !accessor || accessor.type !== "SCALAR" || accessor.count !== count || accessor.normalized || accessor.sparse) throw new Error(`feature accessor does not match ${instanced ? "instance" : "vertex"} count in ${name}`);
        const width = ({ 5121: 1, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[accessor.componentType];
        if (!width || !instanced && accessor.componentType === 5125) throw new Error(`invalid feature accessor componentType in ${name}`);
        const bytes = view(accessor.bufferView), stride = doc.bufferViews[accessor.bufferView].byteStride ?? width, offset = accessor.byteOffset ?? 0;
        if (offset < 0 || stride < width || offset + (count - 1) * stride + width > bytes.length) throw new Error(`feature accessor exceeds bufferView in ${name}`);
        for (let i = 0; i < count; i++) {
          const position = offset + i * stride;
          const value = accessor.componentType === 5126 ? bytes.readFloatLE(position) : bytes.readUIntLE(position, width);
          if (!Number.isSafeInteger(value) || value < 0 || value !== set.nullFeatureId && value >= set.featureCount) throw new Error(`feature ID ${value} exceeds featureCount in ${name}`);
        }
        result.featureSets++;
      }
    };
    for (const node of doc.nodes ?? []) {
      const extension = node.extensions?.EXT_instance_features;
      if (!extension) continue;
      const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
      if (!attributes || !doc.meshes?.[node.mesh]) throw new Error(`instance features require mesh instancing in ${name}`);
      const counts = Object.values(attributes).map(index => doc.accessors?.[index as number]?.count);
      if (!counts.length || counts.some(value => !Number.isSafeInteger(value) || value < 1 || value !== counts[0])) throw new Error(`instancing attribute counts differ in ${name}`);
      validateSets(extension.featureIds, attributes, counts[0], true);
      result.instances += counts[0];
    }
    for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.EXT_mesh_features) validateSets(primitive.extensions.EXT_mesh_features.featureIds, primitive.attributes, doc.accessors?.[primitive.attributes.POSITION]?.count, false);
    }
    result.assets++;
  }
  if (expectedFeatures.size) throw new Error("component index references content without matching feature metadata");
  return result;
}

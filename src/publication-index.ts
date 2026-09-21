import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { resolveExistingSafe, safeRelativePath, sha256Buffer, writeAtomic, writeJSONAtomic } from "./fs-utils.js";
import type { JSONObject, ResourceGraph } from "./resource-graph.js";

const READ_LIMIT = 8 << 20;
const SHARD_BUDGET = 4 << 20;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^[a-f0-9]{32}$/;
const TYPES = new Set(["conductor", "ground-wire", "jumper", "tower-body", "insulator", "hardware", "unknown"]);
const compareText = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const componentKey = (record: JSONObject): string => JSON.stringify([record.objectKey, record.componentId]);
const compareKey = (a: JSONObject, b: JSONObject): number => compareText(a.objectKey, b.objectKey) || compareText(a.componentId, b.componentId);

function validBounds(b: JSONObject): boolean {
  return !!b && [b.west, b.south, b.east, b.north, b.minHeight, b.maxHeight].every(Number.isFinite)
    && b.west >= -180 && b.west <= 180 && b.east >= -180 && b.east <= 180 && b.south >= -90 && b.north <= 90 && b.south <= b.north && b.minHeight <= b.maxHeight;
}

function containsBounds(outer: JSONObject, inner: JSONObject): boolean {
  const intervals = (b: JSONObject): number[][] => b.west <= b.east ? [[b.west, b.east]] : [[b.west, 180], [-180, b.east]];
  return outer.south <= inner.south && outer.north >= inner.north && outer.minHeight <= inner.minHeight && outer.maxHeight >= inner.maxHeight
    && intervals(inner).every(([west, east]) => intervals(outer).some(([a, b]) => a! <= west! && b! >= east!));
}

function managementPath(root: string, path: unknown): string {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0") || path !== safeRelativePath(root, path)) throw new Error(`invalid publication index path: ${String(path)}`);
  return path;
}

async function readIndex(graph: ResourceGraph, path: string, hash?: string, limit = READ_LIMIT): Promise<JSONObject> {
  const absolute = await resolveExistingSafe(graph.root, managementPath(graph.root, path));
  if (hash !== undefined && !HASH.test(hash)) throw new Error(`invalid publication index hash: ${path}`);
  if ((await stat(absolute)).size > limit) throw new Error(`publication index exceeds read limit: ${path}`);
  const bytes = await readFile(absolute), actual = await sha256Buffer(bytes);
  if (bytes.length > limit || hash !== undefined && hash !== actual) throw new Error(`publication index hash mismatch: ${path}`);
  const json = JSON.parse(bytes.toString("utf8")) as JSONObject;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`invalid publication index: ${path}`);
  graph.documents.set(path, json); graph.files.set(path, { sha256: actual, bytes: bytes.length });
  return json;
}

export function validateComponentRecord(record: JSONObject, graph: ResourceGraph): void {
  if (!record || !record.sceneId || !record.objectId || record.objectKey !== `${record.sceneId}/${record.objectId}` || !record.componentId || !record.entityId || !record.entityType || !record.prototypeKey || !TYPES.has(record.componentType) || !validBounds(record.bounds)
    || !Array.isArray(record.position) || record.position.length !== 3 || !record.position.every(Number.isFinite) || Math.abs(record.position[0]) > 180 || Math.abs(record.position[1]) > 90 || !Array.isArray(record.contents) || !record.contents.length) throw new Error("invalid component index record");
  const seen = new Set<string>();
  for (const content of record.contents) {
    if (!content || !graph.gltfs.has(content.path) || !Number.isSafeInteger(content.level) || content.level < 0 || seen.has(JSON.stringify(content))) throw new Error(`component content is invalid or not reachable: ${content?.path}`);
    seen.add(JSON.stringify(content));
  }
}

// 管理资料只从入口声明发现；_build 不参与发布索引读取。
export async function loadPublicationManagement(graph: ResourceGraph): Promise<void> {
  const entries = [...graph.documents].filter(([, json]) => typeof json.asset?.extras?.catalog === "string");
  for (const [entryPath, entry] of entries) {
    const extras = entry.asset.extras;
    const strict = extras.componentIndex !== undefined || extras.catalogSHA256 !== undefined;
    if (strict && (!RELEASE.test(extras.releaseId) || !HASH.test(extras.catalogSHA256))) throw new Error(`invalid release/catalog identity: ${entryPath}`);
    const catalog = await readIndex(graph, extras.catalog, strict ? extras.catalogSHA256 : undefined);
    if (catalog.schema !== "model-optimizer.tileset-catalog" || catalog.version !== 1 || strict && catalog.releaseId !== extras.releaseId) throw new Error(`unsupported or inconsistent publication catalog: ${extras.catalog}`);
    if (extras.objectIndex !== catalog.objectIndex || (extras.componentIndex ?? "") !== (catalog.componentIndex ?? "")) throw new Error(`root/catalog index paths differ: ${entryPath}`);
    const objects = await readIndex(graph, catalog.objectIndex, strict ? catalog.objectIndexSHA256 ?? "" : undefined, 64 << 20);
    if (objects.schema !== "model-optimizer.tileset-objects" || objects.version !== 1 || !Array.isArray(objects.objects)) throw new Error("invalid object index");
    if (!catalog.componentIndex) continue;
    const index = await readIndex(graph, catalog.componentIndex, catalog.componentIndexSHA256 ?? "");
    if (index.schema !== "model-optimizer.tileset-components" || index.version !== 1 || !Number.isSafeInteger(index.count) || index.count < 0 || !Array.isArray(index.shards)) throw new Error("invalid component index");
    let count = 0, previous: JSONObject | undefined;
    const objectKeys = new Set(objects.objects.map((record: JSONObject) => record.objectKey));
    for (const info of index.shards) {
      const shard = await readIndex(graph, info.path, info.sha256 ?? "");
      if (shard.schema !== "model-optimizer.tileset-component-shard" || shard.version !== 1 || !Array.isArray(shard.components) || !shard.components.length || shard.components.length !== info.count || !validBounds(info.bounds)) throw new Error("invalid component shard");
      const types: Record<string, number> = {};
      for (const record of shard.components) {
        validateComponentRecord(record, graph);
        if (!containsBounds(info.bounds, record.bounds)) throw new Error("component shard bounds do not contain records");
        if (!objectKeys.has(record.objectKey) || previous && compareKey(previous, record) >= 0) throw new Error("component keys are duplicate, unsorted or absent from object index");
        previous = record; types[record.componentType] = (types[record.componentType] ?? 0) + 1;
      }
      if (!info.first || !info.last || compareKey(info.first, shard.components[0]) || compareKey(info.last, shard.components.at(-1)) || Object.keys(types).length !== Object.keys(info.componentTypes ?? {}).length || Object.entries(types).some(([key, value]) => info.componentTypes[key] !== value)) throw new Error("component shard summary mismatch");
      count += shard.components.length;
    }
    if (count !== index.count) throw new Error("component index count mismatch");
  }
}

function unionBounds(records: JSONObject[]): JSONObject {
  const bounds = records.map(record => record.bounds);
  const first = { ...bounds[0] };
  for (const b of bounds.slice(1)) {
    if (first.west > first.east || b.west > b.east) { first.west = -180; first.east = 180; }
    else { first.west = Math.min(first.west, b.west); first.east = Math.max(first.east, b.east); }
    first.south = Math.min(first.south, b.south); first.north = Math.max(first.north, b.north);
    first.minHeight = Math.min(first.minHeight, b.minHeight); first.maxHeight = Math.max(first.maxHeight, b.maxHeight);
  }
  return first;
}

export async function rewritePublicationManagement(graph: ResourceGraph, output: string, paths: Map<string, string>, releaseId: string): Promise<void> {
  const rewritten = new Map<string, { path: string; hash: string; catalog: JSONObject }>();
  const rewrite = (path: string): string => {
    const target = paths.get(path);
    if (!target) throw new Error(`management resource not in input snapshot: ${path}`);
    return target;
  };
  for (const [entryPath, entry] of graph.documents) {
    const extras = entry.asset?.extras;
    if (typeof extras?.catalog !== "string") continue;
    let updated = rewritten.get(extras.catalog);
    if (!updated) {
      const catalog = structuredClone(graph.documents.get(extras.catalog)!);
      const objects = structuredClone(graph.documents.get(catalog.objectIndex)!);
      for (const object of objects.objects) object.contents = (object.contents ?? []).map(rewrite);
      catalog.objectIndex = rewrite(catalog.objectIndex);
      await writeJSONAtomic(join(output, catalog.objectIndex), objects, true);
      catalog.objectIndexSHA256 = await sha256Buffer(await readFile(join(output, catalog.objectIndex)));
      if (catalog.componentIndex) {
        const source = graph.documents.get(catalog.componentIndex)!;
        const target = rewrite(catalog.componentIndex);
        const index: JSONObject = { schema: source.schema, version: source.version, count: source.count, shards: [] };
        let batch: JSONObject[] = [], size = Buffer.byteLength('{"schema":"model-optimizer.tileset-component-shard","version":1,"components":[]}\n');
        const flush = async (): Promise<void> => {
          if (!batch.length) return;
          const path = posix.join(posix.dirname(target), "shards", `${String(index.shards.length).padStart(6, "0")}.json`);
          const bytes = Buffer.from(JSON.stringify({ schema: "model-optimizer.tileset-component-shard", version: 1, components: batch }) + "\n");
          if (bytes.length > SHARD_BUDGET) throw new Error("rewritten component shard exceeds budget");
          await writeAtomic(join(output, path), bytes);
          const types: Record<string, number> = {};
          for (const record of batch) types[record.componentType] = (types[record.componentType] ?? 0) + 1;
          const key = (record: JSONObject): JSONObject => ({ objectKey: record.objectKey, componentId: record.componentId });
          index.shards.push({ path, sha256: await sha256Buffer(bytes), count: batch.length, first: key(batch[0]!), last: key(batch.at(-1)!), componentTypes: types, bounds: unionBounds(batch) });
          batch = []; size = Buffer.byteLength('{"schema":"model-optimizer.tileset-component-shard","version":1,"components":[]}\n');
        };
        for (const info of source.shards) for (const original of graph.documents.get(info.path)!.components) {
          const record = structuredClone(original);
          record.contents = record.contents.map((content: JSONObject) => ({ ...content, path: rewrite(content.path) }));
          const bytes = Buffer.byteLength(JSON.stringify(record));
          if (batch.length && batch[0]!.objectKey !== record.objectKey || size + bytes + (batch.length ? 1 : 0) > SHARD_BUDGET) await flush();
          size += bytes + (batch.length ? 1 : 0); batch.push(record);
        }
        await flush();
        await writeJSONAtomic(join(output, target), index, true);
        catalog.componentIndex = target;
        catalog.componentIndexSHA256 = await sha256Buffer(await readFile(join(output, target)));
      }
      catalog.root = rewrite(catalog.root); catalog.releaseId = releaseId;
      for (const node of catalog.nodes ?? []) node.payloadPath = rewrite(node.payloadPath);
      const path = rewrite(extras.catalog);
      await writeJSONAtomic(join(output, path), catalog, true);
      updated = { path, hash: await sha256Buffer(await readFile(join(output, path))), catalog }; rewritten.set(extras.catalog, updated);
    }
    const target = rewrite(entryPath), json = JSON.parse(await readFile(join(output, target), "utf8")) as JSONObject;
    Object.assign(json.asset.extras, { releaseId, catalog: updated.path, catalogSHA256: updated.hash, objectIndex: updated.catalog.objectIndex });
    if (updated.catalog.componentIndex) json.asset.extras.componentIndex = updated.catalog.componentIndex;
    await writeJSONAtomic(join(output, target), json, true);
  }
}

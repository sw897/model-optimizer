import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { zipSync } from "fflate";
import { createZip, extractZip, fetchPinned, requireDiskSpace } from "../scripts/native-assets.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temporary = async () => { const root = await mkdtemp(join(tmpdir(), "native-assets-")); roots.push(root); return root; };

it("round-trips Unicode/spaced filenames in a portable ZIP", async () => {
  const root = await temporary(), out = await temporary(), zip = join(out, "portable.zip");
  await writeFile(join(root, "输入 文件.txt"), "synthetic");
  await createZip(root, zip);
  await extractZip(await readFile(zip), out);
  expect(await readFile(join(out, root.split(/[\\/]/).at(-1)!, "输入 文件.txt"), "utf8")).toBe("synthetic");
});
it("rejects ZIP traversal and Windows case collisions", async () => {
  const root = await temporary();
  await expect(extractZip(zipSync({ "../escape": new Uint8Array([1]) }), root)).rejects.toThrow("Unsafe ZIP path");
  await expect(extractZip(zipSync({ "app/File": new Uint8Array([1]), "app/file": new Uint8Array([2]) }), root)).rejects.toThrow("Conflicting Windows ZIP path");
});
it("rejects a corrupted pinned download cache before using it", async () => {
  const root = await temporary(), digest = "0".repeat(64);
  await writeFile(join(root, `${digest}-asset.zip`), "corrupted fixture");
  await expect(fetchPinned({ url: "https://example.invalid/asset.zip", sha256: digest }, root)).rejects.toThrow("Cached asset SHA-256 mismatch");
});

it("rejects an impossible disk reservation before beginning a large build", async () => {
  const root = await temporary();
  await expect(requireDiskSpace(root, Number.MAX_SAFE_INTEGER)).rejects.toThrow("Insufficient build space");
});

import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { arch, platform, tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { pathExists } from "./fs-utils.js";

const require = createRequire(import.meta.url);
const execFile = promisify(execFileCallback);
export type TextureUsage = "color" | "data" | "normal";

export async function findBasisuBinary(): Promise<string> {
  const packageRoot = dirname(require.resolve("basisu/package.json"));
  const platformName = platform() === "win32" ? "win" : platform();
  const extension = platformName === "win" ? ".exe" : "";
  for (const directory of [`${arch()}_sse`, arch()]) {
    const candidate = join(packageRoot, "bin", platformName, directory, `basisu${extension}`);
    if (await pathExists(candidate)) {
      if (platformName !== "win") await chmod(candidate, 0o755);
      return candidate;
    }
  }
  throw new Error(`BasisU does not provide a binary for ${platform()} ${arch()}`);
}

export async function encodeKTX2(image: Buffer, usage: TextureUsage, basisuPath: string): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "model-optimizer-texture-"));
  try {
    const inputPath = join(root, "input.png");
    const outputPath = join(root, "output.ktx2");
    await writeFile(inputPath, await sharp(image).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer());
    const args = ["-ktx2", "-mipmap", "-output_file", outputPath, "-file", inputPath];
    if (usage !== "color") {
      args.push("-uastc", "-uastc_level", "2", "-linear");
      if (usage === "normal") args.push("-normal_map");
    } else args.push("-q", "192", "-comp_level", "2");
    await execFile(basisuPath, args, { maxBuffer: 4 * 1024 * 1024 });
    const bytes = await readFile(outputPath);
    if (bytes.length < 80 || bytes.subarray(0, 12).toString("hex") !== "ab4b5458203230bb0d0a1a0a") throw new Error("BasisU produced invalid KTX2");
    return bytes;
  } catch (error) {
    throw new Error(`KTX2 encoding failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

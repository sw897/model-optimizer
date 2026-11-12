import { readFileSync } from "node:fs";

export const NATIVE_TOOLS = JSON.parse(readFileSync(new URL("../native-tools.lock.json", import.meta.url), "utf8")) as {
  basisu: {
    version: string;
    "windows-x64": { path: string; sha256: string; profile: string };
  };
};
const windows = NATIVE_TOOLS.basisu["windows-x64"];
export const TEXTURE_ENCODER_ID = process.platform === "win32"
  ? `basisu@${NATIVE_TOOLS.basisu.version}:${windows.profile}:${windows.sha256}`
  : `basisu@${NATIVE_TOOLS.basisu.version}:npm:${process.platform}-${process.arch}`;

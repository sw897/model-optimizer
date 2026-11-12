import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function npmEnvironment() {
  const env = { ...process.env };
  // npm 11 exports file-based allow-scripts into lifecycle environments, then
  // rejects that inherited value as a CLI policy on nested project commands.
  // Let each child reread the original .npmrc policy instead of changing it.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
  return env;
}

export function npmCLIPath() {
  if (!process.env.npm_execpath) throw new Error("Run this script through its npm run command.");
  return process.env.npm_execpath;
}

export async function runNpm(args, cwd) {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [npmCLIPath(), ...args], { cwd, env: npmEnvironment(), stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? done() : reject(Object.assign(new Error(`npm ${args[0]} failed (${signal ?? code})`), { exitCode: code ?? 1 })));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNpm(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}

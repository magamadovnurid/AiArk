import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { AiArkError } from "./errors";

export interface LaunchOptions {
  runtimeExecutable: string;
  modelPath: string;
  mode?: "chat" | "server";
  prompt?: string;
  contextSize?: number;
  gpuLayers?: number;
  port?: number;
}

export interface LaunchSpec {
  command: string;
  args: string[];
}

export function buildLaunchSpec(options: LaunchOptions): LaunchSpec {
  const contextSize = Math.max(512, Math.min(options.contextSize ?? 4096, 131072));
  const gpuLayers = Math.max(0, Math.min(options.gpuLayers ?? 999, 999));
  const args = ["-m", options.modelPath, "-c", String(contextSize), "-ngl", String(gpuLayers)];
  if (options.mode === "server") {
    const port = Math.max(1024, Math.min(options.port ?? 8080, 65535));
    args.push("--port", String(port));
  } else if (options.prompt) {
    args.push("-p", options.prompt);
  }
  return { command: options.runtimeExecutable, args };
}

export async function launchModel(options: LaunchOptions): Promise<number> {
  await access(options.runtimeExecutable);
  await access(options.modelPath);
  const spec = buildLaunchSpec(options);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: "inherit", shell: false });
    child.once("error", (error) => reject(new AiArkError("Unable to launch model runtime", "LAUNCH_FAILED", error)));
    child.once("exit", (code, signal) => {
      if (signal) reject(new AiArkError(`Runtime exited on signal ${signal}`, "RUNTIME_SIGNAL"));
      else resolve(code ?? 1);
    });
  });
}

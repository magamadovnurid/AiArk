import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { CommandRunner, systemCommandRunner } from "./command";
import { ChunkedDownloader, DownloadOptions, Fetcher } from "./download";
import { AiArkError } from "./errors";
import { Accelerator, HardwareProfile, RuntimeCatalog, RuntimeDefinition, RuntimeInstallPlan } from "./types";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  assets: GitHubAsset[];
}

export function localRuntimeRoot(platform: HardwareProfile["platform"] = process.platform as HardwareProfile["platform"]): string {
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AiArk", "runtimes");
  if (platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AiArk", "runtimes");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "aiark", "runtimes");
}

function acceleratorPreference(hardware: HardwareProfile): Accelerator[] {
  const detected = hardware.gpus.map((gpu) => gpu.accelerator);
  return [...new Set([...detected, "cpu" as const])];
}

async function findExecutable(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return candidate;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = await findExecutable(path.join(root, entry.name), name);
    if (nested) return nested;
  }
  return null;
}

export class RuntimeManager {
  constructor(
    private readonly catalog: RuntimeCatalog,
    private readonly fetcher: Fetcher = fetch,
    private readonly runner: CommandRunner = systemCommandRunner,
  ) {}

  async plan(runtimeId: string, hardware: HardwareProfile): Promise<RuntimeInstallPlan> {
    const definition = this.definition(runtimeId);
    const response = await this.fetcher(definition.releasesApi, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "AiArk/0.1" },
    });
    if (!response.ok) throw new AiArkError(`Runtime release lookup failed with HTTP ${response.status}`, "RUNTIME_LOOKUP_FAILED");
    const releases = await response.json() as GitHubRelease[];
    const preferences = acceleratorPreference(hardware);
    for (const accelerator of preferences) {
      const rules = definition.assets.filter((rule) =>
        rule.platform === hardware.platform && rule.arch === hardware.arch && rule.accelerator === accelerator,
      );
      for (const release of releases.filter((item) => !item.draft)) {
        for (const rule of rules) {
          const expression = new RegExp(rule.pattern);
          const asset = release.assets.find((candidate) => expression.test(candidate.name));
          if (!asset) continue;
          return {
            runtimeId,
            version: release.tag_name,
            accelerator,
            downloadUrl: asset.browser_download_url,
            archiveName: asset.name,
            sizeBytes: asset.size,
            sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : null,
            installDirectory: path.join(localRuntimeRoot(hardware.platform), runtimeId, release.tag_name, accelerator),
          };
        }
      }
    }
    throw new AiArkError(`No ${runtimeId} build matches ${hardware.platform}/${hardware.arch}`, "RUNTIME_NOT_AVAILABLE");
  }

  async install(
    plan: RuntimeInstallPlan,
    hardware: HardwareProfile,
    options: DownloadOptions = {},
  ): Promise<{ executable: string; installDirectory: string; alreadyInstalled: boolean }> {
    if (!plan.sha256) {
      throw new AiArkError("Runtime asset has no publisher SHA-256 digest", "UNVERIFIED_RUNTIME");
    }
    const definition = this.definition(plan.runtimeId);
    const executableName = definition.executable[hardware.platform];
    try {
      const existing = await findExecutable(plan.installDirectory, executableName);
      if (existing && (await stat(existing)).isFile()) {
        return { executable: existing, installDirectory: plan.installDirectory, alreadyInstalled: true };
      }
    } catch {
      // Continue with a new managed install.
    }

    const root = localRuntimeRoot(hardware.platform);
    const cache = path.join(root, ".cache");
    await mkdir(cache, { recursive: true });
    const archivePath = path.join(cache, plan.archiveName);
    const downloader = new ChunkedDownloader(this.fetcher);
    await downloader.download(`${plan.runtimeId}-${plan.version}-${plan.accelerator}`, {
      url: plan.downloadUrl,
      fileName: plan.archiveName,
      sizeBytes: plan.sizeBytes,
      sha256: plan.sha256,
      chunkSizeBytes: 16 * 1024 * 1024,
    }, archivePath, options);

    const list = await this.runner.run("tar", ["-tf", archivePath], 60_000);
    if (list.exitCode !== 0) throw new AiArkError("Unable to inspect runtime archive", "ARCHIVE_INSPECTION_FAILED", list.stderr);
    const unsafe = list.stdout.split(/\r?\n/).filter(Boolean).find((entry) => path.isAbsolute(entry) || entry.split(/[\\/]/).includes(".."));
    if (unsafe) throw new AiArkError(`Unsafe runtime archive entry: ${unsafe}`, "UNSAFE_ARCHIVE");

    const staging = `${plan.installDirectory}.staging-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const extract = await this.runner.run("tar", ["-xf", archivePath, "-C", staging], 120_000);
    if (extract.exitCode !== 0) {
      await rm(staging, { recursive: true, force: true });
      throw new AiArkError("Runtime extraction failed", "ARCHIVE_EXTRACTION_FAILED", extract.stderr);
    }
    const executable = await findExecutable(staging, executableName);
    if (!executable) {
      await rm(staging, { recursive: true, force: true });
      throw new AiArkError(`Runtime archive does not contain ${executableName}`, "RUNTIME_EXECUTABLE_MISSING");
    }
    if (hardware.platform !== "win32") await chmod(executable, 0o755);
    await mkdir(path.dirname(plan.installDirectory), { recursive: true });
    await rm(plan.installDirectory, { recursive: true, force: true });
    await rename(staging, plan.installDirectory);
    const finalExecutable = path.join(plan.installDirectory, path.relative(staging, executable));
    await writeFile(path.join(plan.installDirectory, "runtime.json"), `${JSON.stringify({
      schemaVersion: 1,
      runtimeId: plan.runtimeId,
      version: plan.version,
      accelerator: plan.accelerator,
      sha256: plan.sha256,
      installedAt: new Date().toISOString(),
      executable: path.relative(plan.installDirectory, finalExecutable),
    }, null, 2)}\n`, "utf8");
    return { executable: finalExecutable, installDirectory: plan.installDirectory, alreadyInstalled: false };
  }

  private definition(runtimeId: string): RuntimeDefinition {
    const definition = this.catalog.runtimes.find((item) => item.id === runtimeId);
    if (!definition) throw new AiArkError(`Unknown runtime: ${runtimeId}`, "UNKNOWN_RUNTIME");
    return definition;
  }
}

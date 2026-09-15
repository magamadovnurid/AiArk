import os from "node:os";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CommandRunner, systemCommandRunner } from "./command";
import { Accelerator, GpuInfo, HardwareProfile, Platform } from "./types";

function platformName(value: NodeJS.Platform): Platform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`Unsupported platform: ${value}`);
}

function vendorFromName(name: string): GpuInfo["vendor"] {
  const lower = name.toLowerCase();
  if (lower.includes("apple")) return "apple";
  if (lower.includes("nvidia") || lower.includes("geforce") || lower.includes("quadro")) return "nvidia";
  if (lower.includes("amd") || lower.includes("radeon")) return "amd";
  if (lower.includes("intel")) return "intel";
  return "unknown";
}

function acceleratorFor(vendor: GpuInfo["vendor"], platform: Platform): Accelerator {
  if (vendor === "apple") return "metal";
  if (vendor === "nvidia") return "cuda";
  if (vendor === "amd") return platform === "win32" ? "vulkan" : "rocm";
  if (vendor === "intel") return "vulkan";
  return "cpu";
}

export class HardwareDetector {
  constructor(
    private readonly runner: CommandRunner = systemCommandRunner,
    private readonly platform: Platform = platformName(process.platform),
  ) {}

  async detect(): Promise<HardwareProfile> {
    const gpus = await this.detectGpus();
    const cpu = os.cpus();
    return {
      platform: this.platform,
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpuModel: cpu[0]?.model?.trim() || "Unknown CPU",
      cpuCores: cpu.length,
      ramBytes: os.totalmem(),
      gpus: gpus.length ? gpus : [{
        name: "CPU only",
        vendor: "unknown",
        vramBytes: null,
        accelerator: "cpu",
        unifiedMemory: false,
      }],
      detectedAt: new Date().toISOString(),
    };
  }

  private async detectGpus(): Promise<GpuInfo[]> {
    const nvidia = await this.detectNvidiaSmi();
    if (nvidia.length) return nvidia;
    if (this.platform === "darwin") return this.detectMacGpus();
    if (this.platform === "win32") return this.detectWindowsGpus();
    return this.detectLinuxGpus();
  }

  private async detectNvidiaSmi(): Promise<GpuInfo[]> {
    const result = await this.runner.run("nvidia-smi", [
      "--query-gpu=name,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = line.match(/^(.*),\s*([0-9.]+)$/);
      const name = match?.[1]?.trim() || line.trim();
      const mib = Number(match?.[2] || 0);
      return {
        name,
        vendor: "nvidia" as const,
        vramBytes: mib > 0 ? Math.round(mib * 1024 * 1024) : null,
        accelerator: "cuda" as const,
        unifiedMemory: false,
      };
    });
  }

  private async detectMacGpus(): Promise<GpuInfo[]> {
    const result = await this.runner.run("system_profiler", ["SPDisplaysDataType", "-json"]);
    if (result.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(result.stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
      return (parsed.SPDisplaysDataType ?? []).map((gpu) => {
        const name = String(gpu.sppci_model || gpu._name || "Apple GPU");
        const unifiedMemory = vendorFromName(name) === "apple";
        const vramText = String(gpu.spdisplays_vram || gpu.spdisplays_vram_shared || "");
        const vramMatch = vramText.match(/([0-9.]+)\s*(GB|MB)/i);
        const multiplier = vramMatch?.[2]?.toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2;
        return {
          name,
          vendor: vendorFromName(name),
          vramBytes: unifiedMemory ? os.totalmem() : vramMatch ? Number(vramMatch[1]) * multiplier : null,
          accelerator: "metal" as const,
          unifiedMemory,
        };
      });
    } catch {
      return [];
    }
  }

  private async detectWindowsGpus(): Promise<GpuInfo[]> {
    const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress";
    let result = await this.runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (result.exitCode !== 0) {
      result = await this.runner.run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]);
    }
    if (result.exitCode !== 0) return [];
    try {
      const raw = JSON.parse(result.stdout) as Record<string, unknown> | Array<Record<string, unknown>>;
      const records = Array.isArray(raw) ? raw : [raw];
      return records.filter((gpu) => gpu.Name).map((gpu) => {
        const name = String(gpu.Name);
        const vendor = vendorFromName(name);
        const bytes = Number(gpu.AdapterRAM || 0);
        return {
          name,
          vendor,
          vramBytes: bytes > 0 ? bytes : null,
          accelerator: acceleratorFor(vendor, "win32"),
          unifiedMemory: false,
        };
      });
    } catch {
      return [];
    }
  }

  private async detectLinuxGpus(): Promise<GpuInfo[]> {
    const result = await this.runner.run("lspci", ["-nn"]);
    if (result.exitCode !== 0) return [];
    const cards = await this.readLinuxVram();
    let cardIndex = 0;
    return result.stdout.split(/\r?\n/)
      .filter((line) => /VGA compatible controller|3D controller|Display controller/i.test(line))
      .map((line) => {
        const name = line.replace(/^.*?:\s*/, "").trim();
        const vendor = vendorFromName(name);
        const vramBytes = cards[cardIndex] ?? null;
        cardIndex += 1;
        return {
          name,
          vendor,
          vramBytes,
          accelerator: acceleratorFor(vendor, "linux"),
          unifiedMemory: false,
        };
      });
  }

  private async readLinuxVram(): Promise<Array<number | null>> {
    try {
      const drmEntries = (await readdir("/sys/class/drm")).filter((name) => /^card\d+$/.test(name)).sort();
      return await Promise.all(drmEntries.map(async (entry) => {
        try {
          const value = await readFile(path.join("/sys/class/drm", entry, "device/mem_info_vram_total"), "utf8");
          const bytes = Number(value.trim());
          return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
        } catch {
          return null;
        }
      }));
    } catch {
      return [];
    }
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { AiArkError } from "./errors";
import { CompatibilityResult, HardwareProfile, ModelCatalog, ModelManifestEntry, RuntimeCatalog } from "./types";

function configPath(fileName: string): string {
  if (process.env.AIARK_CONFIG_DIR) return path.join(process.env.AIARK_CONFIG_DIR, fileName);
  return path.resolve(__dirname, "../config", fileName);
}

async function loadJson<T>(fileName: string): Promise<T> {
  const candidates = [
    configPath(fileName),
    path.resolve(__dirname, "../../config", fileName),
    path.resolve(process.cwd(), "config", fileName),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AiArkError(`Invalid configuration: ${candidate}`, "INVALID_CONFIG", error);
      }
    }
  }
  throw new AiArkError(`Configuration file not found: ${fileName}`, "CONFIG_NOT_FOUND", candidates);
}

export async function loadModelCatalog(): Promise<ModelCatalog> {
  const catalog = await loadJson<ModelCatalog>("models.json");
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.models)) {
    throw new AiArkError("Unsupported model catalog schema", "INVALID_CATALOG");
  }
  return catalog;
}

export async function loadRuntimeCatalog(): Promise<RuntimeCatalog> {
  const catalog = await loadJson<RuntimeCatalog>("runtimes.json");
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.runtimes)) {
    throw new AiArkError("Unsupported runtime catalog schema", "INVALID_CATALOG");
  }
  return catalog;
}

function gigabytes(bytes: number): number {
  return bytes / 1024 ** 3;
}

export function assessModelCompatibility(model: ModelManifestEntry, hardware: HardwareProfile): CompatibilityResult {
  const reasons: string[] = [];
  let score = 100;
  let incompatible = false;
  const requirements = model.requirements;
  const ramGb = gigabytes(hardware.ramBytes);
  const availableAccelerators = new Set(hardware.gpus.map((gpu) => gpu.accelerator));
  const supportedAccelerators = requirements.accelerators ?? [];
  const acceleratorMatch = !supportedAccelerators.length || supportedAccelerators.some((item) => availableAccelerators.has(item));

  if (requirements.platforms && !requirements.platforms.includes(hardware.platform)) {
    reasons.push(`Platform ${hardware.platform} is not supported.`);
    incompatible = true;
  }
  if (requirements.architectures && !requirements.architectures.includes(hardware.arch)) {
    reasons.push(`Architecture ${hardware.arch} is not supported.`);
    incompatible = true;
  }
  if (ramGb < requirements.minRamGb) {
    reasons.push(`Needs at least ${requirements.minRamGb} GB RAM; detected ${ramGb.toFixed(1)} GB.`);
    incompatible = true;
  } else if (ramGb < requirements.recommendedRamGb) {
    reasons.push(`Runs tightly: ${requirements.recommendedRamGb} GB RAM is recommended.`);
    score -= 25;
  } else {
    reasons.push(`RAM fits (${ramGb.toFixed(1)} GB detected).`);
  }

  if (!acceleratorMatch) {
    if (supportedAccelerators.includes("cpu")) {
      reasons.push("No preferred GPU backend detected; CPU fallback is available.");
      score -= 25;
    } else {
      reasons.push(`Needs one of: ${supportedAccelerators.join(", ")}.`);
      incompatible = true;
    }
  } else {
    const match = supportedAccelerators.find((item) => availableAccelerators.has(item));
    if (match) reasons.push(`${match.toUpperCase()} backend is available.`);
  }

  if (requirements.minVramGb) {
    const bestVramGb = Math.max(0, ...hardware.gpus.map((gpu) => (gpu.vramBytes ?? 0) / 1024 ** 3));
    if (bestVramGb < requirements.minVramGb) {
      if (supportedAccelerators.includes("cpu") && ramGb >= requirements.minRamGb) {
        reasons.push(`GPU memory is below ${requirements.minVramGb} GB; CPU/RAM offload will be slower.`);
        score -= 30;
      } else {
        reasons.push(`Needs ${requirements.minVramGb} GB accelerator memory; detected ${bestVramGb.toFixed(1)} GB.`);
        incompatible = true;
      }
    } else {
      reasons.push(`Accelerator memory fits (${bestVramGb.toFixed(1)} GB detected).`);
    }
  }

  if (incompatible) return { model, status: "incompatible", score: 0, reasons };
  const status = score >= 90 && ramGb >= requirements.recommendedRamGb ? "recommended" : score >= 70 ? "compatible" : "limited";
  return { model, status, score, reasons };
}

export function buildCompatibilityMatrix(catalog: ModelCatalog, hardware: HardwareProfile): CompatibilityResult[] {
  const rank: Record<CompatibilityResult["status"], number> = {
    recommended: 0,
    compatible: 1,
    limited: 2,
    incompatible: 3,
  };
  return catalog.models
    .map((model) => assessModelCompatibility(model, hardware))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score || a.model.name.localeCompare(b.model.name));
}

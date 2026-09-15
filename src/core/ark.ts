import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AiArkError } from "./errors";
import { DiskAssessment, ModelCatalog } from "./types";

export const ARK_DIRECTORIES = [
  ".aiark/downloads",
  ".aiark/checksums",
  ".aiark/logs",
  "models/gguf",
  "models/onnx",
  "models/safetensors",
  "manifests",
  "library",
  "datasets",
  "exports",
  "docs",
] as const;

export interface PreparationPreview {
  dryRun: true;
  diskId: string;
  targetRoot: string | null;
  canPrepare: boolean;
  confirmation: string;
  creates: string[];
  warnings: string[];
  note: string;
}

export interface ArkMetadata {
  schemaVersion: 1;
  arkId: string;
  label: "AIARK";
  diskFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreparedArkStatus {
  prepared: boolean;
  root: string | null;
}

function rootFor(assessment: DiskAssessment): string | null {
  return assessment.mountedWritableVolume?.mountPoint
    ? path.join(assessment.mountedWritableVolume.mountPoint, "AIARK")
    : null;
}

export function previewPreparation(assessment: DiskAssessment): PreparationPreview {
  const targetRoot = rootFor(assessment);
  return {
    dryRun: true,
    diskId: assessment.disk.id,
    targetRoot,
    canPrepare: assessment.canPrepare,
    confirmation: assessment.confirmation,
    creates: targetRoot ? [targetRoot, ...ARK_DIRECTORIES.map((directory) => path.join(targetRoot, directory))] : [],
    warnings: assessment.warnings,
    note: "No partition, filesystem, label, or existing user file is changed by preview.",
  };
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function existingMetadata(root: string): Promise<ArkMetadata | null> {
  try {
    return JSON.parse(await readFile(path.join(root, "ark.json"), "utf8")) as ArkMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AiArkError("Existing ark.json is not readable JSON", "INVALID_ARK_METADATA", error);
  }
}

export async function inspectPreparedArk(assessment: DiskAssessment): Promise<PreparedArkStatus> {
  const mountPoint = assessment.mountedWritableVolume?.mountPoint;
  if (!mountPoint) return { prepared: false, root: null };
  let root: string;
  try {
    root = path.join(await realpath(mountPoint), "AIARK");
  } catch {
    return { prepared: false, root: path.join(mountPoint, "AIARK") };
  }
  try {
    const metadata = await existingMetadata(root);
    return {
      prepared: metadata?.schemaVersion === 1
        && metadata.label === "AIARK"
        && metadata.diskFingerprint === assessment.disk.fingerprint,
      root,
    };
  } catch {
    return { prepared: false, root };
  }
}

async function ensureManagedDirectory(root: string, relativePath: string): Promise<string> {
  let current = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AiArkError(`Managed path is not a normal directory: ${current}`, "UNSAFE_TARGET");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}

export async function prepareArk(
  assessment: DiskAssessment,
  confirmation: string,
  catalog: ModelCatalog,
): Promise<{ root: string; metadata: ArkMetadata; createdDirectories: string[] }> {
  if (confirmation !== assessment.confirmation) {
    throw new AiArkError("Typed confirmation does not match the selected disk", "CONFIRMATION_REQUIRED");
  }
  if (!assessment.canPrepare) {
    throw new AiArkError("Disk does not meet the safe universal AiArk profile", "DISK_NOT_PREPARABLE", assessment.warnings);
  }
  const mountPoint = assessment.mountedWritableVolume?.mountPoint;
  if (!mountPoint) throw new AiArkError("Disk is not mounted", "DISK_NOT_MOUNTED");
  await access(mountPoint, constants.W_OK);
  const realMount = await realpath(mountPoint);
  const root = path.join(realMount, "AIARK");
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AiArkError("AIARK target exists but is not a normal directory", "UNSAFE_TARGET");
    }
    const metadata = await existingMetadata(root);
    if (!metadata) {
      throw new AiArkError("AIARK directory already exists without a valid ark.json marker", "FOREIGN_DIRECTORY");
    }
    if (metadata.diskFingerprint !== assessment.disk.fingerprint) {
      throw new AiArkError("Existing AIARK metadata belongs to another disk fingerprint", "FINGERPRINT_MISMATCH");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { mode: 0o700 });
  }

  const createdDirectories: string[] = [];
  for (const directory of ARK_DIRECTORIES) {
    const fullPath = await ensureManagedDirectory(root, directory);
    createdDirectories.push(fullPath);
  }
  const previous = await existingMetadata(root);
  const now = new Date().toISOString();
  const metadata: ArkMetadata = {
    schemaVersion: 1,
    arkId: previous?.arkId ?? randomUUID(),
    label: "AIARK",
    diskFingerprint: assessment.disk.fingerprint,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await atomicJson(path.join(root, "ark.json"), metadata);
  await atomicJson(path.join(root, "manifests", "catalog.json"), catalog);
  const libraryPath = path.join(root, "library", "index.json");
  try {
    await access(libraryPath);
  } catch {
    await atomicJson(libraryPath, { schemaVersion: 1, models: [] });
  }
  return { root, metadata, createdDirectories };
}

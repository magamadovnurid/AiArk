import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { ChunkedDownloader, DownloadOptions } from "./download";
import { AiArkError } from "./errors";
import { ModelCatalog, ModelManifestEntry } from "./types";

interface LibraryRecord {
  id: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  installedAt: string;
  verifiedAt: string;
}

interface LibraryIndex {
  schemaVersion: 1;
  models: LibraryRecord[];
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function assertArkRoot(root: string): Promise<string> {
  try {
    const canonical = await realpath(root);
    const metadata = JSON.parse(await readFile(path.join(canonical, "ark.json"), "utf8")) as { schemaVersion?: number; label?: string };
    if (metadata.schemaVersion !== 1 || metadata.label !== "AIARK") throw new Error("invalid marker");
    return canonical;
  } catch (error) {
    throw new AiArkError("Selected directory is not a prepared AiArk", "INVALID_ARK_ROOT", error);
  }
}

async function safeModelDestination(root: string, model: ModelManifestEntry): Promise<string> {
  const fileName = path.basename(model.artifact.fileName);
  if (fileName !== model.artifact.fileName) throw new AiArkError("Manifest filename is unsafe", "UNSAFE_MANIFEST");
  const directory = await realpath(path.join(root, "models", model.format));
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    throw new AiArkError("Model directory resolves outside the ark", "UNSAFE_TARGET");
  }
  return path.join(directory, fileName);
}

async function readLibrary(root: string): Promise<LibraryIndex> {
  try {
    const value = JSON.parse(await readFile(path.join(root, "library", "index.json"), "utf8")) as LibraryIndex;
    return value.schemaVersion === 1 && Array.isArray(value.models) ? value : { schemaVersion: 1, models: [] };
  } catch {
    return { schemaVersion: 1, models: [] };
  }
}

export class ModelManager {
  constructor(
    private readonly catalog: ModelCatalog,
    private readonly downloader = new ChunkedDownloader(),
  ) {}

  get(modelId: string): ModelManifestEntry {
    const model = this.catalog.models.find((item) => item.id === modelId);
    if (!model) throw new AiArkError(`Unknown model: ${modelId}`, "UNKNOWN_MODEL");
    return model;
  }

  destination(root: string, model: ModelManifestEntry): string {
    const fileName = path.basename(model.artifact.fileName);
    if (fileName !== model.artifact.fileName) throw new AiArkError("Manifest filename is unsafe", "UNSAFE_MANIFEST");
    return path.join(root, "models", model.format, fileName);
  }

  async download(modelId: string, root: string, options: DownloadOptions = {}): Promise<LibraryRecord> {
    root = await assertArkRoot(root);
    const model = this.get(modelId);
    const destination = await safeModelDestination(root, model);
    await this.downloader.download(model.id, model.artifact, destination, options);
    const now = new Date().toISOString();
    const library = await readLibrary(root);
    const previous = library.models.find((item) => item.id === model.id);
    const record: LibraryRecord = {
      id: model.id,
      path: path.relative(root, destination),
      sizeBytes: model.artifact.sizeBytes,
      sha256: model.artifact.sha256,
      installedAt: previous?.installedAt ?? now,
      verifiedAt: now,
    };
    library.models = [...library.models.filter((item) => item.id !== model.id), record].sort((a, b) => a.id.localeCompare(b.id));
    await atomicJson(path.join(root, "library", "index.json"), library);
    return record;
  }

  async verify(modelId: string, root: string): Promise<{ ok: boolean; actualSha256: string | null; path: string }> {
    root = await assertArkRoot(root);
    const model = this.get(modelId);
    const destination = await safeModelDestination(root, model);
    const result = await this.downloader.verify(model.artifact, destination);
    if (result.ok) {
      const library = await readLibrary(root);
      const record = library.models.find((item) => item.id === model.id);
      if (record) {
        record.verifiedAt = new Date().toISOString();
        await atomicJson(path.join(root, "library", "index.json"), library);
      }
    }
    return { ...result, path: destination };
  }

  async repair(modelId: string, root: string, options: DownloadOptions = {}): Promise<{ path: string; repairedChunks: number[]; backupPath: string | null }> {
    root = await assertArkRoot(root);
    const model = this.get(modelId);
    const destination = await safeModelDestination(root, model);
    const result = await this.downloader.repair(model.id, model.artifact, destination, options);
    await this.download(modelId, root, options);
    return result;
  }

  async listInstalled(root: string): Promise<LibraryIndex> {
    root = await assertArkRoot(root);
    return readLibrary(root);
  }
}

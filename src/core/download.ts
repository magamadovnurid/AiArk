import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { AiArkError, asErrorMessage } from "./errors";
import { DownloadProgress, ModelArtifact } from "./types";

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface DownloadState {
  schemaVersion: 1;
  artifactId: string;
  url: string;
  totalBytes: number;
  chunkSizeBytes: number;
  sha256: string;
  completedChunks: number[];
  updatedAt: string;
}

export interface DownloadOptions {
  concurrency?: number;
  retries?: number;
  onProgress?: (progress: DownloadProgress) => void;
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new AiArkError("Invalid artifact id", "INVALID_ARTIFACT_ID");
  return cleaned;
}

function authHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "AiArk/0.1" };
  if (process.env.HF_TOKEN && new URL(url).hostname.endsWith("huggingface.co")) {
    headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  }
  return headers;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function saveState(filePath: string, state: DownloadState): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export class ChunkedDownloader {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async download(
    artifactId: string,
    artifact: ModelArtifact,
    destination: string,
    options: DownloadOptions = {},
  ): Promise<{ path: string; sha256: string; resumed: boolean }> {
    const id = safeId(artifactId);
    await mkdir(path.dirname(destination), { recursive: true });
    const existingSize = await fileSize(destination);
    if (existingSize === artifact.sizeBytes && await sha256File(destination) === artifact.sha256.toLowerCase()) {
      return { path: destination, sha256: artifact.sha256.toLowerCase(), resumed: true };
    }
    if (existingSize > 0) {
      throw new AiArkError("Existing model file failed checksum; run repair instead", "CHECKSUM_MISMATCH", destination);
    }

    const probe = await this.probe(artifact.url);
    if (probe.totalBytes && probe.totalBytes !== artifact.sizeBytes) {
      throw new AiArkError("Remote artifact size does not match manifest", "REMOTE_SIZE_MISMATCH", probe);
    }
    if (!probe.rangeSupported) {
      return this.downloadSingle(id, artifact, destination, options);
    }
    return this.downloadChunks(id, artifact, destination, options);
  }

  async verify(artifact: ModelArtifact, destination: string): Promise<{ ok: boolean; actualSha256: string | null }> {
    if (await fileSize(destination) !== artifact.sizeBytes) return { ok: false, actualSha256: null };
    const actualSha256 = await sha256File(destination);
    return { ok: actualSha256 === artifact.sha256.toLowerCase(), actualSha256 };
  }

  async repair(
    artifactId: string,
    artifact: ModelArtifact,
    destination: string,
    options: DownloadOptions = {},
  ): Promise<{ path: string; repairedChunks: number[]; backupPath: string | null }> {
    const verification = await this.verify(artifact, destination);
    if (verification.ok) return { path: destination, repairedChunks: [], backupPath: null };

    if (artifact.chunkSha256?.length && await fileSize(destination) === artifact.sizeBytes) {
      const repairedChunks = await this.repairKnownChunks(artifact, destination, options);
      const after = await this.verify(artifact, destination);
      if (!after.ok) throw new AiArkError("Chunk repair completed but full checksum still fails", "REPAIR_FAILED", after);
      return { path: destination, repairedChunks, backupPath: null };
    }

    const repairedPath = `${destination}.repair`;
    await rm(repairedPath, { force: true });
    const result = await this.download(`${artifactId}-repair`, artifact, repairedPath, options);
    const backupPath = await fileSize(destination) > 0 ? `${destination}.corrupt-${Date.now()}` : null;
    if (backupPath) await rename(destination, backupPath);
    await rename(result.path, destination);
    return { path: destination, repairedChunks: [], backupPath };
  }

  private async probe(url: string): Promise<{ totalBytes: number | null; rangeSupported: boolean }> {
    const response = await this.fetcher(url, { method: "HEAD", headers: authHeaders(url), redirect: "follow" });
    if (!response.ok) throw new AiArkError(`Remote probe failed with HTTP ${response.status}`, "DOWNLOAD_PROBE_FAILED");
    const length = response.headers.get("content-length") ?? response.headers.get("x-linked-size");
    return {
      totalBytes: length ? Number(length) : null,
      rangeSupported: /bytes/i.test(response.headers.get("accept-ranges") ?? ""),
    };
  }

  private async downloadChunks(
    artifactId: string,
    artifact: ModelArtifact,
    destination: string,
    options: DownloadOptions,
  ): Promise<{ path: string; sha256: string; resumed: boolean }> {
    const chunkSizeBytes = artifact.chunkSizeBytes ?? 128 * 1024 * 1024;
    const totalChunks = Math.ceil(artifact.sizeBytes / chunkSizeBytes);
    const stateDirectory = path.join(path.dirname(destination), ".aiark-downloads");
    const chunkDirectory = path.join(stateDirectory, `${artifactId}.chunks`);
    const statePath = path.join(stateDirectory, `${artifactId}.json`);
    await mkdir(chunkDirectory, { recursive: true });
    let state: DownloadState = {
      schemaVersion: 1,
      artifactId,
      url: artifact.url,
      totalBytes: artifact.sizeBytes,
      chunkSizeBytes,
      sha256: artifact.sha256.toLowerCase(),
      completedChunks: [],
      updatedAt: new Date().toISOString(),
    };
    try {
      const previous = JSON.parse(await readFile(statePath, "utf8")) as DownloadState;
      if (previous.url === state.url && previous.totalBytes === state.totalBytes && previous.sha256 === state.sha256 && previous.chunkSizeBytes === state.chunkSizeBytes) {
        state = previous;
      }
    } catch {
      // A missing or corrupt state file starts a safe revalidation of all chunk files.
    }

    const completed = new Set<number>();
    let downloadedBytes = 0;
    for (let index = 0; index < totalChunks; index += 1) {
      const expectedSize = Math.min(chunkSizeBytes, artifact.sizeBytes - index * chunkSizeBytes);
      const chunkPath = path.join(chunkDirectory, `${String(index).padStart(6, "0")}.part`);
      if (await fileSize(chunkPath) === expectedSize) {
        const expectedHash = artifact.chunkSha256?.[index];
        if (!expectedHash || await sha256File(chunkPath) === expectedHash.toLowerCase()) {
          completed.add(index);
          downloadedBytes += expectedSize;
        }
      }
    }
    const resumed = completed.size > 0;
    const report = (): void => options.onProgress?.({
      artifactId,
      downloadedBytes,
      totalBytes: artifact.sizeBytes,
      completedChunks: completed.size,
      totalChunks,
    });
    report();

    const pending = Array.from({ length: totalChunks }, (_, index) => index).filter((index) => !completed.has(index));
    let cursor = 0;
    let stateWrite = Promise.resolve();
    const persistState = async (): Promise<void> => {
      const snapshot: DownloadState = {
        ...state,
        completedChunks: [...completed].sort((a, b) => a - b),
        updatedAt: new Date().toISOString(),
      };
      stateWrite = stateWrite.then(() => saveState(statePath, snapshot));
      await stateWrite;
    };
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (cursor < pending.length) {
        const index = pending[cursor++];
        if (index === undefined) return;
        const start = index * chunkSizeBytes;
        const end = Math.min(artifact.sizeBytes - 1, start + chunkSizeBytes - 1);
        const chunkPath = path.join(chunkDirectory, `${String(index).padStart(6, "0")}.part`);
        await this.fetchRange(artifact.url, start, end, chunkPath, options.retries ?? 3);
        const expectedHash = artifact.chunkSha256?.[index];
        if (expectedHash && await sha256File(chunkPath) !== expectedHash.toLowerCase()) {
          throw new AiArkError(`Chunk ${index} failed checksum`, "CHUNK_CHECKSUM_MISMATCH");
        }
        completed.add(index);
        downloadedBytes += end - start + 1;
        await persistState();
        report();
      }
    });
    await Promise.all(workers);

    const partial = `${destination}.partial`;
    await rm(partial, { force: true });
    for (let index = 0; index < totalChunks; index += 1) {
      const chunkPath = path.join(chunkDirectory, `${String(index).padStart(6, "0")}.part`);
      await pipeline(createReadStream(chunkPath), createWriteStream(partial, { flags: index === 0 ? "w" : "a" }));
    }
    const actualSha256 = await sha256File(partial);
    if (actualSha256 !== artifact.sha256.toLowerCase()) {
      throw new AiArkError("Downloaded file failed SHA-256 verification", "CHECKSUM_MISMATCH", { expected: artifact.sha256, actual: actualSha256 });
    }
    await rename(partial, destination);
    await rm(chunkDirectory, { recursive: true, force: true });
    return { path: destination, sha256: actualSha256, resumed };
  }

  private async downloadSingle(
    artifactId: string,
    artifact: ModelArtifact,
    destination: string,
    options: DownloadOptions,
  ): Promise<{ path: string; sha256: string; resumed: boolean }> {
    const partial = `${destination}.partial`;
    let offset = await fileSize(partial);
    if (offset > artifact.sizeBytes) {
      await rm(partial, { force: true });
      offset = 0;
    }
    const headers = authHeaders(artifact.url);
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    const response = await this.fetcher(artifact.url, { headers, redirect: "follow" });
    if (!response.ok || !response.body) throw new AiArkError(`Download failed with HTTP ${response.status}`, "DOWNLOAD_FAILED");
    const append = offset > 0 && response.status === 206;
    if (offset > 0 && !append) offset = 0;
    let downloadedBytes = offset;
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      options.onProgress?.({ artifactId, downloadedBytes, totalBytes: artifact.sizeBytes, completedChunks: 0, totalChunks: 1 });
    });
    await pipeline(source, createWriteStream(partial, { flags: append ? "a" : "w" }));
    if (await fileSize(partial) !== artifact.sizeBytes) throw new AiArkError("Downloaded size does not match manifest", "REMOTE_SIZE_MISMATCH");
    const actualSha256 = await sha256File(partial);
    if (actualSha256 !== artifact.sha256.toLowerCase()) throw new AiArkError("Downloaded file failed SHA-256 verification", "CHECKSUM_MISMATCH");
    await rename(partial, destination);
    return { path: destination, sha256: actualSha256, resumed: append };
  }

  private async fetchRange(url: string, start: number, end: number, destination: string, retries: number): Promise<void> {
    let lastError = "unknown error";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          headers: { ...authHeaders(url), Range: `bytes=${start}-${end}` },
          redirect: "follow",
        });
        if (response.status !== 206 || !response.body) {
          throw new AiArkError(`Range request returned HTTP ${response.status}`, "RANGE_UNSUPPORTED");
        }
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { flags: "w" }));
        const expected = end - start + 1;
        if (await fileSize(destination) !== expected) throw new Error(`Expected ${expected} bytes`);
        return;
      } catch (error) {
        lastError = asErrorMessage(error);
        await rm(destination, { force: true });
        if (attempt < retries) await sleep(Math.min(250 * 2 ** attempt, 2_000));
      }
    }
    throw new AiArkError(`Chunk download failed: ${lastError}`, "DOWNLOAD_RETRIES_EXHAUSTED");
  }

  private async repairKnownChunks(artifact: ModelArtifact, destination: string, options: DownloadOptions): Promise<number[]> {
    const chunkSize = artifact.chunkSizeBytes ?? 128 * 1024 * 1024;
    const file = await open(destination, "r+");
    const repaired: number[] = [];
    try {
      for (let index = 0; index < (artifact.chunkSha256?.length ?? 0); index += 1) {
        const start = index * chunkSize;
        const size = Math.min(chunkSize, artifact.sizeBytes - start);
        const buffer = Buffer.alloc(size);
        await file.read(buffer, 0, size, start);
        const actual = createHash("sha256").update(buffer).digest("hex");
        const expected = artifact.chunkSha256?.[index]?.toLowerCase();
        if (actual === expected) continue;
        const temporary = `${destination}.repair-chunk-${index}`;
        await this.fetchRange(artifact.url, start, start + size - 1, temporary, options.retries ?? 3);
        const replacement = await readFile(temporary);
        if (createHash("sha256").update(replacement).digest("hex") !== expected) {
          throw new AiArkError(`Replacement chunk ${index} failed checksum`, "CHUNK_CHECKSUM_MISMATCH");
        }
        await file.write(replacement, 0, replacement.length, start);
        await rm(temporary, { force: true });
        repaired.push(index);
        options.onProgress?.({ artifactId: "repair", downloadedBytes: repaired.length * chunkSize, totalBytes: artifact.sizeBytes, completedChunks: repaired.length, totalChunks: artifact.chunkSha256?.length ?? 0 });
      }
    } finally {
      await file.close();
    }
    return repaired;
  }
}

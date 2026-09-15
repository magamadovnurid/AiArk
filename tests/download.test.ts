import { createHash } from "node:crypto";
import { createServer, Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChunkedDownloader } from "../src/core/download";
import { ModelArtifact } from "../src/core/types";

const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));
const chunkSize = 8192;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const artifact: ModelArtifact = {
  url: "",
  fileName: "fixture.gguf",
  sizeBytes: payload.length,
  sha256: hash(payload),
  chunkSizeBytes: chunkSize,
  chunkSha256: Array.from({ length: payload.length / chunkSize }, (_, index) => hash(payload.subarray(index * chunkSize, (index + 1) * chunkSize))),
};

let server: Server;
let root: string;
let requestedRanges: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "aiark-download-"));
  requestedRanges = [];
  server = createServer((request, response) => {
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Length", payload.length);
    if (request.method === "HEAD") return response.end();
    const range = request.headers.range;
    if (!range) { response.statusCode = 200; return response.end(payload); }
    requestedRanges.push(range);
    const match = range.match(/bytes=(\d+)-(\d+)/)!;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const chunk = payload.subarray(start, end + 1);
    response.statusCode = 206;
    response.setHeader("Content-Length", chunk.length);
    response.setHeader("Content-Range", `bytes ${start}-${end}/${payload.length}`);
    response.end(chunk);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  artifact.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/fixture.gguf`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("ChunkedDownloader", () => {
  it("resumes validated chunks, assembles the file, and verifies SHA-256", async () => {
    const destination = path.join(root, "models", "fixture.gguf");
    const cached = path.join(root, "models", ".aiark-downloads", "fixture.chunks");
    await mkdir(cached, { recursive: true });
    await writeFile(path.join(cached, "000000.part"), payload.subarray(0, chunkSize));
    const result = await new ChunkedDownloader().download("fixture", artifact, destination, { concurrency: 3 });
    expect(result.resumed).toBe(true);
    expect(await readFile(destination)).toEqual(payload);
    expect(requestedRanges).not.toContain(`bytes=0-${chunkSize - 1}`);
  });

  it("repairs only corrupt chunks when chunk hashes are available", async () => {
    const destination = path.join(root, "fixture.gguf");
    const corrupt = Buffer.from(payload);
    corrupt[chunkSize + 7] = 255;
    await writeFile(destination, corrupt);
    const result = await new ChunkedDownloader().repair("fixture", artifact, destination);
    expect(result.repairedChunks).toEqual([1]);
    expect(await readFile(destination)).toEqual(payload);
  });
});

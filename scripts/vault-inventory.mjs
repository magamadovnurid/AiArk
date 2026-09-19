#!/usr/bin/env node
// Read-only inventory of a prepared AiArk vault. SHA-256 is opt-in because a
// complete audit reads terabytes and should normally wait for downloads to end.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadProcessPids } from "./vault-watchdog.mjs";

const SCRIPT = fileURLToPath(import.meta.url);

function inside(root, destination) {
  const relative = path.relative(root, destination);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readCompletedPaths(logFile) {
  let log;
  try { log = await fs.readFile(logFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const paths = new Set();
  for (const line of log.split("\n")) {
    const match = line.match(/\[NOTICE\].*Download complete: (\/[^\r\n]+)$/);
    if (match) paths.add(match[1]);
  }
  return paths;
}

export async function buildInventory(manifest, arkRoot, { verifySha256 = false, completedPaths = new Set() } = {}) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.packages)) throw new Error("Invalid vault manifest");
  const root = path.resolve(arkRoot);
  const seen = new Set();
  const files = [];
  const summary = {
    files: 0, expectedBytes: 0, observedBytes: 0, completeBytes: 0,
    present: 0, verified: 0, missing: 0, partial: 0, oversized: 0, corrupt: 0,
    gatedFiles: 0, gatedExpectedBytes: 0, hashAvailableFiles: 0, hashCheckedFiles: 0,
  };

  for (const item of manifest.packages) {
    if (typeof item.id !== "string" || !Array.isArray(item.files)) throw new Error("Invalid package in vault manifest");
    for (const entry of item.files) {
      if (typeof entry.destination !== "string" || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
        throw new Error(`Invalid file in package ${item.id}`);
      }
      if (entry.sha256 != null && !/^[a-f\d]{64}$/i.test(entry.sha256)) throw new Error(`Invalid SHA-256 in package ${item.id}`);
      const destination = path.resolve(entry.destination);
      if (!inside(root, destination)) throw new Error(`Manifest path leaves ark: ${destination}`);
      if (seen.has(destination)) throw new Error(`Duplicate manifest destination: ${destination}`);
      seen.add(destination);

      let stat;
      try { stat = await fs.lstat(destination); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (stat && !stat.isFile()) throw new Error(`Manifest destination is not a regular file: ${destination}`);
      const sizeBytes = stat?.size ?? 0;
      const controlFile = await fs.access(`${destination}.aria2`).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      let status = !stat ? "missing" : sizeBytes > entry.sizeBytes ? "oversized"
        : sizeBytes < entry.sizeBytes || (controlFile && !completedPaths.has(destination)) ? "partial" : "present";
      let actualSha256 = null;
      if (verifySha256 && status === "present" && entry.sha256) {
        actualSha256 = await digest(destination);
        status = actualSha256 === entry.sha256.toLowerCase() ? "verified" : "corrupt";
        summary.hashCheckedFiles += 1;
      }

      const relativePath = path.relative(root, destination);
      files.push({ packageId: item.id, gated: Boolean(item.gated), path: relativePath,
        expectedBytes: entry.sizeBytes, observedBytes: sizeBytes, status,
        sha256: entry.sha256?.toLowerCase() ?? null, actualSha256 });
      summary.files += 1;
      summary.expectedBytes += entry.sizeBytes;
      summary.observedBytes += Math.min(sizeBytes, entry.sizeBytes);
      summary[status] += 1;
      if (status === "present" || status === "verified") summary.completeBytes += entry.sizeBytes;
      if (item.gated) { summary.gatedFiles += 1; summary.gatedExpectedBytes += entry.sizeBytes; }
      if (entry.sha256) summary.hashAvailableFiles += 1;
    }
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), arkRoot: root,
    manifestProfile: manifest.profile ?? null, verifySha256, summary, files };
}

async function main() {
  const args = process.argv.slice(2);
  const arkFlag = args.indexOf("--ark");
  if (arkFlag < 0 || !args[arkFlag + 1]) throw new Error("Usage: vault-inventory.mjs --ark <path> [--manifest <path>] [--summary] [--sha256]");
  const root = path.resolve(args[arkFlag + 1]);
  const manifestFlag = args.indexOf("--manifest");
  if (manifestFlag >= 0 && !args[manifestFlag + 1]) throw new Error("--manifest needs a path");
  const manifestFile = manifestFlag >= 0 ? path.resolve(args[manifestFlag + 1])
    : path.join(root, "manifests", "vault-standard-4tb.json");
  if (args.includes("--sha256") && process.platform === "darwin") {
    const processes = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const session = path.join(root, ".aiark", "downloads", "vault-resume.aria2");
    if (downloadProcessPids(processes, session).length) {
      throw new Error("Stop the matching vault downloader before the full SHA-256 audit");
    }
  }
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  const completedPaths = await readCompletedPaths(path.join(root, ".aiark", "logs", "vault-download.log"));
  const result = await buildInventory(manifest, root, { verifySha256: args.includes("--sha256"), completedPaths });
  console.log(JSON.stringify(args.includes("--summary") ? { generatedAt: result.generatedAt,
    arkRoot: result.arkRoot, manifestProfile: result.manifestProfile, summary: result.summary }
    : result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

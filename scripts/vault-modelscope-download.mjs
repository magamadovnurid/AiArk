#!/usr/bin/env node
// Resumable, checksum-verified Gemma mirror download for the prepared AIARK disk.
// Runs only when explicitly approved in the private watchdog config.
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDisk } from "./vault-watchdog.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "AiArk", "VaultWatchdog");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PAUSE_FILE = path.join(DATA_DIR, "paused");
const PACKAGE_ID = "ltx-2.3-gemma-encoder";
const MIRROR_REPO = "Lightricks/gemma-3-12b-it-qat-q4_0-unquantized";
const MIRROR_REVISION = "d99b96521cc01ff8887604f9a083deba33707df9";
const GOOGLE_REVISION = "68f7ee4fbd59087436ada77ed2d62f373fdd4482";
const ATTRIBUTES_REVISION = "d62fe4f1995ade703b49a0f3c0d0f161237ef437";
const ATTRIBUTES_SHA256 = "8467a3e5ede24bcb4275b227390efd6853f648fd01701e39a64be6032ffd2351";
let child = null;
let stopping = false;

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 30_000, ...options });
}

function jsonUrl(url) {
  const result = command("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location",
    "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "20", "--max-time", "25", url]);
  return JSON.parse(result);
}

function diskInfo(mountPoint) {
  const plist = command("/usr/sbin/diskutil", ["info", "-plist", mountPoint]);
  return JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: plist }));
}

async function ensureSafe(config, root) {
  if (stopping || await fs.access(PAUSE_FILE).then(() => true, () => false)) throw new Error("User pause is active");
  const ark = JSON.parse(await fs.readFile(path.join(root, "ark.json"), "utf8"));
  const issue = validateDisk(diskInfo(config.mountPoint), ark, config);
  if (issue) throw new Error(issue);
}

export function mirrorFilePlan(manifest, mirrorFiles, googleFiles, root) {
  const item = manifest.packages?.find((entry) => entry.id === PACKAGE_ID);
  if (!item?.gated || item.repository !== "google/gemma-3-12b-it-qat-q4_0-unquantized" ||
      item.revision !== GOOGLE_REVISION || item.files?.length !== 18) throw new Error("Unexpected Gemma manifest");
  const mirror = new Map(mirrorFiles.map((file) => [file.Path, file]));
  const google = new Map(googleFiles.map((file) => [file.path, file]));
  const base = path.join(root, "models", "video", PACKAGE_ID);
  return item.files.map((file) => {
    if (!file.path || path.isAbsolute(file.path) || file.path.split("/").includes("..") ||
        path.resolve(file.destination) !== path.resolve(base, file.path)) throw new Error(`Unsafe Gemma path: ${file.path}`);
    const canonical = google.get(file.path);
    if (!canonical || canonical.size !== file.sizeBytes) throw new Error(`Canonical metadata changed: ${file.path}`);
    if (file.path === ".gitattributes") {
      if (canonical.oid !== "8520ea7c1ebe287a3cf516c16a72b8a899f0f127") throw new Error("Gemma attributes changed");
      return { ...file, sha256: ATTRIBUTES_SHA256, gitOid: canonical.oid,
        url: `https://huggingface.co/${MIRROR_REPO}/resolve/${ATTRIBUTES_REVISION}/.gitattributes` };
    }
    const copy = mirror.get(file.path);
    if (!copy || copy.Revision !== MIRROR_REVISION || copy.Size !== file.sizeBytes ||
        !/^[a-f0-9]{64}$/.test(copy.Sha256) || (file.sha256 && file.sha256 !== copy.Sha256)) {
      throw new Error(`Mirror metadata differs from Gemma manifest: ${file.path}`);
    }
    const query = new URLSearchParams({ Revision: MIRROR_REVISION, FilePath: file.path });
    return { ...file, sha256: copy.Sha256, gitOid: canonical.lfs ? null : canonical.oid,
      url: `https://modelscope.cn/api/v1/models/${MIRROR_REPO}/repo?${query}` };
  });
}

async function digest(file, algorithm = "sha256", gitBlob = false) {
  const hash = createHash(algorithm);
  if (gitBlob) hash.update(`blob ${(await fs.stat(file)).size}\0`);
  for await (const chunk of createReadStream(file)) {
    if (stopping) throw new Error("Download stopped by user pause or disk guard");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verified(file, candidate) {
  let stat;
  try { stat = await fs.stat(candidate); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.size !== file.sizeBytes) return false;
  if (await digest(candidate) !== file.sha256) return false;
  return !file.gitOid || await digest(candidate, "sha1", true) === file.gitOid;
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    child = spawn("/usr/bin/curl", ["--fail", "--show-error", "--silent", "--location", "--continue-at", "-",
      "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "30", "--output", destination, url],
    { stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => { child = null; resolve({ code, signal }); });
  });
}

async function quarantine(file) {
  const target = `${file}.corrupt-${new Date().toISOString().replaceAll(":", "-")}`;
  await fs.rename(file, target);
  console.error(`Preserved a failed checksum file for inspection: ${target}`);
}

async function fetchFile(file) {
  const final = file.destination;
  if (await verified(file, final)) return;
  const part = `${final}.part`;
  await fs.mkdir(path.dirname(final), { recursive: true });
  try {
    const stat = await fs.stat(final);
    if (stat.size < file.sizeBytes && !await fs.access(part).then(() => true, () => false)) await fs.rename(final, part);
    else await quarantine(final);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (await verified(file, part)) { await fs.rename(part, final); return; }
  try { if ((await fs.stat(part)).size >= file.sizeBytes) await quarantine(part); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
    const result = await download(file.url, part);
    if (stopping) throw new Error("Download stopped by user pause or disk guard");
    if (result.code === 0) break;
    if (attempt === 2) throw new Error(`Download failed for ${file.path}: curl exit ${result.code}`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  if (!await verified(file, part)) {
    await quarantine(part);
    throw new Error(`Checksum mismatch for ${file.path}; corrupt bytes were preserved`);
  }
  await fs.rename(part, final);
  console.log(`Verified ${file.path} (${file.sizeBytes} bytes)`);
}

async function main() {
  const root = process.argv[2];
  if (root !== "/Volumes/AIARK/AIARK") throw new Error("Expected the prepared AIARK vault path");
  const config = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  if ((config.approvedModelScopePackage !== PACKAGE_ID && !process.argv.includes("--plan")) ||
      typeof config.diskUUID !== "string" || !config.arkId || !config.diskFingerprint)
    throw new Error("ModelScope Gemma download is not approved for this disk");
  await ensureSafe(config, root);
  const manifest = JSON.parse(await fs.readFile(config.manifestFile, "utf8"));
  const listing = jsonUrl(`https://modelscope.cn/api/v1/models/${MIRROR_REPO}/repo/files?Revision=${MIRROR_REVISION}&Recursive=true`);
  if (listing.Code !== 200 || !Array.isArray(listing.Data?.Files)) throw new Error("ModelScope mirror listing unavailable");
  const google = jsonUrl(`https://huggingface.co/api/models/google/gemma-3-12b-it-qat-q4_0-unquantized/tree/${GOOGLE_REVISION}?expand=true`);
  if (!Array.isArray(google)) throw new Error("Canonical Gemma metadata unavailable");
  const files = mirrorFilePlan(manifest, listing.Data.Files, google, root);
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify({ packageId: PACKAGE_ID, files: files.length,
      bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), mirrorRevision: MIRROR_REVISION }));
    return;
  }
  const ledger = path.join(root, ".aiark", "checksums", `${PACKAGE_ID}.json`);
  await fs.unlink(ledger).catch((error) => { if (error.code !== "ENOENT") throw error; });
  for (const file of files) {
    await ensureSafe(config, root);
    await fetchFile(file);
  }
  await ensureSafe(config, root);
  const report = { packageId: PACKAGE_ID, mirror: `https://modelscope.cn/models/${MIRROR_REPO}`,
    mirrorRevision: MIRROR_REVISION, canonicalRevision: GOOGLE_REVISION, verifiedAt: new Date().toISOString(),
    files: files.map(({ path: name, sizeBytes, sha256, gitOid }) => ({ path: name, sizeBytes, sha256, gitOid })) };
  await fs.mkdir(path.dirname(ledger), { recursive: true });
  await fs.writeFile(`${ledger}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(`${ledger}.tmp`, ledger);
  console.log(`Gemma mirror complete: ${files.length} verified files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    stopping = true;
    if (child) child.kill("SIGINT");
  });
  main().catch((error) => { console.error(error.message); process.exitCode = stopping ? 130 : 1; });
}

#!/usr/bin/env node
// macOS supervisor for the current large, resumable AiArk vault download.
// It never prepares or formats a disk. A matching external volume is mandatory.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "AiArk", "VaultWatchdog");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PAUSE_FILE = path.join(DATA_DIR, "paused");
const LOCK_DIR = path.join(DATA_DIR, "check.lock");
const INSTALLED_SCRIPT = path.join(DATA_DIR, "vault-watchdog.mjs");
const CHECK_INTERVAL_MS = 30_000;
const LABEL = "dev.aiark.vault-watchdog";
const PLIST_FILE = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: "utf8", timeout: 12_000, ...options });
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, value, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function diskInfo(mountPoint) {
  const plist = command("/usr/sbin/diskutil", ["info", "-plist", mountPoint]);
  return JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: plist }));
}

export function validateDisk(disk, ark, config) {
  if (disk?.MountPoint !== config.mountPoint || disk?.VolumeName !== "AIARK") return "AIARK is not mounted at the expected path";
  if (disk?.Internal !== false || disk?.RemovableMediaOrExternalDevice !== true) return "The mounted volume is not external";
  if (disk?.DiskUUID !== config.diskUUID) return "The mounted disk UUID does not match";
  if (disk?.FilesystemName !== "ExFAT" || disk?.Size < 4_000_000_000_000) return "The disk format or size changed";
  if (ark?.arkId !== config.arkId || ark?.diskFingerprint !== config.diskFingerprint) return "The AiArk identity does not match";
  return null;
}

export function pendingPublicFiles(manifest, root, statFile = (file) => fs.statSync(file), exists = (file) => fs.existsSync(file), completedPaths = new Set()) {
  const pending = [];
  let observedBytes = 0;
  let newestMtimeMs = 0;
  let complete = 0;
  for (const item of manifest.packages ?? []) {
    if (item.gated) continue;
    for (const file of item.files ?? []) {
      const destination = path.resolve(file.destination);
      if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Manifest path leaves ark: ${destination}`);
      let stat;
      try { stat = statFile(destination); } catch { /* not downloaded yet */ }
      if (stat?.isFile()) {
        observedBytes += Math.min(stat.size, file.sizeBytes);
        newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      }
      // On ExFAT aria2 can leave a control file even after logging successful
      // integrity verification. Size plus a completion log is sufficient here;
      // a separate final SHA-256 audit still follows the full download.
      if (!stat?.isFile() || stat.size !== file.sizeBytes || (exists(`${destination}.aria2`) && !completedPaths.has(destination))) pending.push(file);
      else complete += 1;
    }
  }
  return { pending, complete, observedBytes, newestMtimeMs };
}

export function queueText(files) {
  return files.map((file) => {
    if (!/^https:\/\/huggingface\.co\//.test(file.url)) throw new Error(`Untrusted model URL: ${file.url}`);
    if (/[\r\n]/.test(file.url) || /[\r\n]/.test(file.destination)) throw new Error("Manifest contains a newline in a download field");
    const lines = [file.url, `  dir=${path.dirname(file.destination)}`, `  out=${path.basename(file.destination)}`];
    if (file.sha256) lines.push(`  checksum=sha-256=${file.sha256}`);
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

export function downloadProcessPids(psOutput, saveSessionPath) {
  return psOutput.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    const args = match[2];
    if (!/^(?:\S*\/)?aria2c\s/.test(args)) return [];
    return args.includes(`--save-session=${saveSessionPath}`) ? [Number(match[1])] : [];
  });
}

export function watchProcessPids(psOutput, installedScript) {
  return psOutput.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !/^(?:\S*\/)?node\s/.test(match[2])) return [];
    return match[2].includes(`${installedScript} watch`) ? [Number(match[1])] : [];
  });
}

function activePids(config) {
  const output = command("/bin/ps", ["-axo", "pid=,command="]);
  return downloadProcessPids(output, config.resumeFile);
}

export function signalDownloadPids(pids, signal = (pid) => process.kill(pid, "SIGINT")) {
  for (const pid of pids) {
    try { signal(pid); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  return pids;
}

function stopMatchingDownload(config) {
  return signalDownloadPids(activePids(config));
}

function saveState(patch) {
  const old = readJson(STATE_FILE, {});
  const next = { ...old, ...patch, lastCheckedAt: new Date().toISOString() };
  writeAtomic(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function readConfig() {
  const config = readJson(CONFIG_FILE);
  if (!config || !path.isAbsolute(config.mountPoint) || !path.isAbsolute(config.aria2Path)) {
    throw new Error(`Missing or invalid watchdog configuration: ${CONFIG_FILE}`);
  }
  return config;
}

export function mountedAt(mountOutput, mountPoint) {
  return mountOutput.split("\n").some((line) => line.includes(` on ${mountPoint} (`));
}

function identity(config) {
  let mounts;
  try { mounts = command("/sbin/mount", []); }
  catch { return { reason: "Cannot inspect the mount table", stop: false }; }
  if (!mountedAt(mounts, config.mountPoint)) return { reason: "AIARK is not mounted", stop: true };
  let disk;
  try { disk = diskInfo(config.mountPoint); }
  catch { return { reason: "Cannot verify the mounted disk identity", stop: false }; }
  let ark;
  try { ark = JSON.parse(fs.readFileSync(path.join(config.mountPoint, "AIARK", "ark.json"), "utf8")); }
  catch (error) {
    return error.code === "ENOENT" || error instanceof SyntaxError
      ? { reason: "The AiArk identity file is missing or invalid", stop: true }
      : { reason: "Cannot read the AiArk identity file", stop: false };
  }
  const invalid = validateDisk(disk, ark, config);
  return invalid ? { reason: invalid, stop: true } : null;
}

function recordIdentityFailure(config, issue, extra = {}) {
  const pids = issue.stop ? stopMatchingDownload(config) : activePids(config);
  saveState({ ...extra, status: issue.stop ? "waiting_for_disk" : "needs_attention", aria2Pid: pids[0] ?? null,
    reason: issue.stop
      ? `${issue.reason}; ${pids.length ? "matching download was asked to stop" : "no matching download is running"}`
      : `${issue.reason}; matching download was left intact` });
}

function completedPaths(logFile) {
  let log;
  try { log = fs.readFileSync(logFile, "utf8"); } catch { return new Set(); }
  const paths = new Set();
  for (const line of log.split("\n")) {
    const match = line.match(/\[NOTICE\].*Download complete: (\/Volumes\/AIARK\/AIARK\/models\/.*)$/);
    if (match) paths.add(match[1]);
  }
  return paths;
}

function networkAvailable() {
  try {
    const code = command("/usr/bin/curl", [
      "--head", "--ipv4", "--location", "--max-time", "8", "--silent", "--output", "/dev/null",
      "--write-out", "%{http_code}", "https://huggingface.co/",
    ]).trim();
    return Number(code) >= 200 && Number(code) < 500;
  } catch { return false; }
}

function startDownload(config, files) {
  const queue = path.join(DATA_DIR, "pending.aria2");
  writeAtomic(queue, queueText(files));
  const args = [
    "-dmS", "aiark-vault-download", "/usr/bin/caffeinate", "-i", "-m", "-s", config.aria2Path,
    `--input-file=${queue}`, "--disable-ipv6=true", "--continue=true", "--check-integrity=true",
    "--allow-overwrite=false", "--auto-file-renaming=false", "--max-concurrent-downloads=2",
    "--max-connection-per-server=2", "--split=2", "--min-split-size=64M", "--file-allocation=none",
    "--retry-wait=30", "--max-tries=0", "--timeout=90", "--connect-timeout=30",
    "--summary-interval=60", "--console-log-level=notice", "--download-result=full",
    `--log=${config.logFile}`, "--log-level=notice", `--save-session=${config.resumeFile}`,
    "--save-session-interval=60", "--force-save=true", "--save-not-found=true",
  ];
  command("/usr/bin/screen", args);
}

function acquireCheckLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
    fs.writeFileSync(path.join(LOCK_DIR, "pid"), `${process.pid}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = fs.statSync(LOCK_DIR);
    if (Date.now() - stat.mtimeMs < 30_000) return false;
    let owner = 0;
    try { owner = Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8")); }
    catch { /* process stopped before recording its PID */ }
    try { if (owner > 0) { process.kill(owner, 0); return false; } }
    catch (probeError) { if (probeError.code !== "ESRCH") return false; }
    try { fs.unlinkSync(path.join(LOCK_DIR, "pid")); } catch { /* no PID file */ }
    try { fs.rmdirSync(LOCK_DIR); } catch { return false; }
    return acquireCheckLock();
  }
}

async function check() {
  // A launchd worker may wait for macOS removable-volume consent on its first
  // file open. Do that before taking the shared lock so the detached fallback
  // can keep monitoring while the system prompt awaits the user.
  const config = readConfig();
  try { fs.readFileSync(path.join(config.mountPoint, "AIARK", "ark.json")); }
  catch { /* identity() classifies absent, changed, and inaccessible disks */ }
  if (!acquireCheckLock()) return;
  try { await checkUnlocked(); }
  finally {
    try { fs.unlinkSync(path.join(LOCK_DIR, "pid")); fs.rmdirSync(LOCK_DIR); }
    catch { /* a later check can clear an abandoned lock */ }
  }
}

async function checkUnlocked() {
  const config = readConfig();
  if (fs.existsSync(PAUSE_FILE)) {
    const stopping = stopMatchingDownload(config);
    saveState({ status: "paused", aria2Pid: stopping[0] ?? null, reason: "User pause marker is present; matching download was asked to stop" });
    return;
  }
  const invalid = identity(config);
  if (invalid) { recordIdentityFailure(config, invalid); return; }
  if (!fs.existsSync(config.manifestFile) || !fs.existsSync(config.originalQueue)) {
    saveState({ status: "needs_attention", reason: "The manifest or original download queue is missing" });
    return;
  }
  const manifest = readJson(config.manifestFile);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
    saveState({ status: "needs_attention", reason: "Invalid vault manifest" });
    return;
  }
  const progress = pendingPublicFiles(manifest, path.join(config.mountPoint, "AIARK"),
    (file) => fs.statSync(file), (file) => fs.existsSync(file), completedPaths(config.logFile));
  const previous = readJson(STATE_FILE, {});
  const moved = progress.observedBytes !== previous.observedBytes || progress.newestMtimeMs !== previous.newestMtimeMs;
  const status = {
    publicCompleteFiles: progress.complete,
    publicPendingFiles: progress.pending.length,
    observedBytes: progress.observedBytes,
    newestMtimeMs: progress.newestMtimeMs,
    lastProgressAt: moved ? new Date().toISOString() : (previous.lastProgressAt ?? new Date().toISOString()),
    diskUUID: config.diskUUID,
  };
  if (progress.pending.length === 0) {
    saveState({ ...status, status: "public_queue_complete", reason: "Public files are present; full checksum audit is still required" });
    return;
  }
  const pids = activePids(config);
  if (pids.length > 0) {
    const changedWhileActive = identity(config);
    if (changedWhileActive) { recordIdentityFailure(config, changedWhileActive, status); return; }
    const lastProgress = Date.parse(status.lastProgressAt);
    const stalled = Number.isFinite(lastProgress) && Date.now() - lastProgress > 60 * 60_000;
    saveState({ ...status, status: stalled ? "slow_or_stalled" : "downloading", aria2Pid: pids[0], reason: stalled ? "No file progress for over one hour; process left intact for inspection" : null });
    return;
  }
  if (!networkAvailable()) {
    saveState({ ...status, status: "waiting_for_network", aria2Pid: null, reason: "Hugging Face is unreachable over IPv4" });
    return;
  }
  // A user may pause or remove the disk during the network probe.
  if (fs.existsSync(PAUSE_FILE)) { saveState({ ...status, status: "paused", reason: "User pause marker is present" }); return; }
  const changed = identity(config);
  if (changed) { recordIdentityFailure(config, changed, status); return; }
  if (activePids(config).length) { saveState({ ...status, status: "downloading", reason: null }); return; }
  startDownload(config, progress.pending);
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const started = activePids(config);
  saveState({ ...status, status: started.length ? "downloading" : "needs_attention", aria2Pid: started[0] ?? null,
    reason: started.length ? "Recovered resumable download" : "aria2 exited immediately after launch",
    restartCount: (previous.restartCount ?? 0) + 1, lastRestartAt: new Date().toISOString() });
  if (!started.length) console.error("AiArk vault downloader failed to stay running");
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function refreshInstalledScript() {
  if (process.platform !== "darwin") throw new Error("This helper currently supports macOS only");
  writeAtomic(INSTALLED_SCRIPT, fs.readFileSync(SCRIPT));
  console.log(`Updated installed watchdog script: ${INSTALLED_SCRIPT}`);
}

async function install() {
  if (process.platform !== "darwin") throw new Error("This unattended watchdog currently supports macOS only");
  const mountPoint = "/Volumes/AIARK";
  const disk = diskInfo(mountPoint);
  const ark = readJson(path.join(mountPoint, "AIARK", "ark.json"));
  const config = {
    mountPoint, arkId: ark?.arkId, diskFingerprint: ark?.diskFingerprint, diskUUID: disk.DiskUUID,
    aria2Path: command("/usr/bin/which", ["aria2c"]).trim(),
    manifestFile: path.join(mountPoint, "AIARK", "manifests", "vault-standard-4tb.json"),
    originalQueue: path.join(mountPoint, "AIARK", ".aiark", "downloads", "vault-standard-4tb.aria2"),
    resumeFile: path.join(mountPoint, "AIARK", ".aiark", "downloads", "vault-resume.aria2"),
    logFile: path.join(mountPoint, "AIARK", ".aiark", "logs", "vault-download.log"),
  };
  const invalid = validateDisk(disk, ark, config);
  if (invalid) throw new Error(`Refusing to install watchdog: ${invalid}`);
  if (!fs.existsSync(config.manifestFile) || !fs.existsSync(config.originalQueue)) throw new Error("Vault manifest or queue is missing");
  writeAtomic(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  // LaunchAgents lack the desktop app's Documents-folder privacy grant. Keep
  // their executable code in per-user Application Support, outside Documents.
  refreshInstalledScript();
  const logDir = path.join(os.homedir(), "Library", "Logs", "AiArk");
  fs.mkdirSync(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(INSTALLED_SCRIPT)}</string><string>check</string></array>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>${CHECK_INTERVAL_MS / 1000}</integer>\n<key>AbandonProcessGroup</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(logDir, "vault-watchdog.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(logDir, "vault-watchdog-error.log"))}</string>\n</dict></plist>\n`;
  writeAtomic(PLIST_FILE, plist);
  const domain = `gui/${process.getuid()}`;
  try { command("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]); } catch { /* first installation */ }
  // launchd may still be retiring the previous service immediately after bootout.
  for (let attempt = 0; attempt < 4; attempt++) {
    try { command("/bin/launchctl", ["bootstrap", domain, PLIST_FILE]); break; }
    catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  command("/bin/launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
  console.log(`Installed ${LABEL}: checks every ${CHECK_INTERVAL_MS / 1000} seconds; config ${CONFIG_FILE}`);
}

async function pause() {
  const config = readConfig();
  writeAtomic(PAUSE_FILE, `${new Date().toISOString()}\n`);
  stopMatchingDownload(config);
  for (let i = 0; i < 30 && activePids(config).length; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
  saveState({ status: activePids(config).length ? "pause_requested" : "paused", reason: "User requested a graceful stop" });
  console.log(activePids(config).length ? "Graceful shutdown still in progress" : "Vault download paused safely");
}

async function watch() {
  for (;;) {
    try { await check(); }
    catch (error) {
      console.error(`Watchdog check failed: ${error.message}`);
      saveState({ status: "needs_attention", reason: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

async function restartFallback() {
  if (process.platform !== "darwin") throw new Error("The detached fallback currently supports macOS only");
  readConfig();
  if (!fs.existsSync(INSTALLED_SCRIPT)) throw new Error(`Installed watchdog script is missing: ${INSTALLED_SCRIPT}`);
  const running = () => watchProcessPids(command("/bin/ps", ["-axo", "pid=,command="]), INSTALLED_SCRIPT)
    .filter((pid) => pid !== process.pid);
  for (const pid of running()) {
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  for (let i = 0; i < 20 && running().length; i++) await new Promise((resolve) => setTimeout(resolve, 250));
  if (running().length) throw new Error("Previous detached watchdog did not exit; refusing to start a duplicate");
  command("/usr/bin/screen", ["-dmS", "aiark-vault-watchdog", process.execPath, INSTALLED_SCRIPT, "watch"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const started = running();
  if (started.length !== 1) throw new Error(`Expected one detached watchdog, found ${started.length}`);
  console.log(`Detached watchdog is running as PID ${started[0]}`);
}

async function main() {
  const action = process.argv[2] ?? "status";
  if (action === "install") await install();
  else if (action === "refresh") refreshInstalledScript();
  else if (action === "restart-fallback") await restartFallback();
  else if (action === "check") await check();
  else if (action === "pause") await pause();
  else if (action === "resume") { if (fs.existsSync(PAUSE_FILE)) fs.unlinkSync(PAUSE_FILE); await check(); }
  else if (action === "watch") await watch();
  else if (action === "status") console.log(JSON.stringify({ ...readJson(STATE_FILE, {}), paused: fs.existsSync(PAUSE_FILE) }, null, 2));
  else throw new Error(`Unknown watchdog action: ${action}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

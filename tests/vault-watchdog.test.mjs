import { describe, expect, it } from "vitest";
import path from "node:path";
import { downloadProcessPids, gatedDownloadProcessPids, mountedAt, pendingPublicFiles, preserveApprovedGatedConfig, queueText, signalDownloadPids, validateDisk, watchProcessPids } from "../scripts/vault-watchdog.mjs";

const config = { mountPoint: "/Volumes/AIARK", diskUUID: "volume-123", arkId: "ark-123", diskFingerprint: "finger-123" };
const disk = { MountPoint: "/Volumes/AIARK", VolumeName: "AIARK", Internal: false,
  RemovableMediaOrExternalDevice: true, DiskUUID: "volume-123", FilesystemName: "ExFAT", Size: 4_000_575_389_696 };
const ark = { arkId: "ark-123", diskFingerprint: "finger-123" };

describe("vault watchdog safety", () => {
  it("refuses a lookalike internal disk, changed disk UUID, or changed ark identity", () => {
    expect(validateDisk(disk, ark, config)).toBeNull();
    expect(validateDisk({ ...disk, Internal: true }, ark, config)).toMatch(/external/);
    expect(validateDisk({ ...disk, DiskUUID: "other" }, ark, config)).toMatch(/UUID/);
    expect(validateDisk(disk, { ...ark, arkId: "other" }, config)).toMatch(/identity/);
    expect(validateDisk({ ...disk, MountPoint: "/Volumes/AIARK 1" }, ark, config)).toMatch(/mounted/);
  });

  it("requeues missing, short, and unfinished files, but skips completed files and gated packages", () => {
    const root = "/Volumes/AIARK/AIARK";
    const files = ["ready.gguf", "short.gguf", "partial.gguf", "missing.gguf"].map((name) => ({
      destination: `${root}/models/${name}`, sizeBytes: 100,
      url: `https://huggingface.co/org/repo/resolve/abc/${name}`,
    }));
    const manifest = { packages: [{ gated: false, files }, { gated: true, files: [files[0]] }] };
    const existing = { "ready.gguf": 100, "short.gguf": 60, "partial.gguf": 100 };
    const stat = (file) => {
      const name = path.basename(file);
      if (!(name in existing)) throw new Error("ENOENT");
      return { isFile: () => true, size: existing[name], mtimeMs: 123 };
    };
    const exists = (file) => file.endsWith("ready.gguf.aria2") || file.endsWith("partial.gguf.aria2");
    const result = pendingPublicFiles(manifest, root, stat, exists, new Set([path.resolve(files[0].destination)]));
    expect(result.complete).toBe(1);
    expect(result.pending.map((file) => path.basename(file.destination))).toEqual(["short.gguf", "partial.gguf", "missing.gguf"]);
    expect(result.observedBytes).toBe(260);
  });

  it("never builds a queue outside the ark or from an untrusted URL", () => {
    const root = "/Volumes/AIARK/AIARK";
    const file = { destination: `${root}/models/model.gguf`, sizeBytes: 10,
      url: "https://huggingface.co/org/repo/resolve/abc/model.gguf", sha256: "a".repeat(64) };
    expect(queueText([file])).toContain(`checksum=sha-256=${"a".repeat(64)}`);
    expect(() => queueText([{ ...file, url: "https://evil.example/model.gguf" }])).toThrow(/Untrusted/);
    expect(() => pendingPublicFiles({ packages: [{ gated: false, files: [{ ...file, destination: "/tmp/model.gguf" }] }] }, root)).toThrow(/leaves ark/);
  });

  it("recognizes only the real aria2 download process for this saved session", () => {
    const resume = "/Volumes/AIARK/AIARK/.aiark/downloads/vault-resume.aria2";
    const ps = `  100 SCREEN -dmS aiark-vault-download /usr/bin/caffeinate aria2c --save-session=${resume}\n` +
      `  101 aria2c --input-file=/tmp/other --save-session=/tmp/other\n` +
      `  102 aria2c --input-file=/tmp/pending --save-session=${resume}\n`;
    expect(downloadProcessPids(ps, resume)).toEqual([102]);
  });

  it("recognizes only the exact approved Hugging Face process, not its wrappers", () => {
    const repo = "black-forest-labs/FLUX.2-klein-9B";
    const revision = "92196c8e11f7b6cf2b7493e037d8c5345c559216";
    const dest = "/Volumes/AIARK/AIARK/models/image/flux-2-klein-9b";
    const invocation = `hf download ${repo} LICENSE.md --revision ${revision} --local-dir ${dest} --max-workers 1`;
    const ps = `100 /usr/bin/SCREEN -dmS aiark-flux-download /usr/bin/caffeinate ${invocation}\n` +
      `101 /usr/bin/caffeinate -i /opt/homebrew/bin/${invocation}\n` +
      `102 /opt/homebrew/Cellar/python/Python /opt/homebrew/bin/${invocation}\n` +
      `103 /opt/homebrew/Cellar/python/Python /opt/homebrew/bin/hf download other/repo LICENSE.md --revision ${revision} --local-dir ${dest} --max-workers 1\n`;
    expect(gatedDownloadProcessPids(ps, repo, revision, dest)).toEqual([102]);
    expect(gatedDownloadProcessPids(ps, repo, revision, `${dest}-other`)).toEqual([]);
  });

  it("keeps gated approvals only when reinstalling for the exact same ark", () => {
    const fresh = { arkId: "ark", diskUUID: "disk", mountPoint: "/Volumes/AIARK" };
    const prior = { ...fresh, hfPath: "/opt/homebrew/bin/hf", approvedGatedPackages: [{ id: "flux" }] };
    expect(preserveApprovedGatedConfig(fresh, prior)).toMatchObject({ hfPath: prior.hfPath, approvedGatedPackages: prior.approvedGatedPackages });
    expect(preserveApprovedGatedConfig(fresh, { ...prior, diskUUID: "other" })).toEqual(fresh);
    expect(preserveApprovedGatedConfig(fresh, { ...prior, arkId: "other" })).toEqual(fresh);
  });

  it("signals only matching download PIDs and tolerates an already exited process", () => {
    const signaled = [];
    const pids = [102, 103];
    expect(signalDownloadPids(pids, (pid) => {
      signaled.push(pid);
      if (pid === 103) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    })).toEqual(pids);
    expect(signaled).toEqual(pids);
  });

  it("finds only detached watchdog workers, not screen wrappers or the downloader", () => {
    const script = "/Users/mns/Library/Application Support/AiArk/VaultWatchdog/vault-watchdog.mjs";
    const ps = `1 SCREEN -dmS aiark-vault-watchdog /usr/local/bin/node ${script} watch\n` +
      `2 login -pflq mns /usr/local/bin/node ${script} watch\n` +
      `3 node ${script} watch\n` +
      `4 node ${script} status\n` +
      `5 /opt/homebrew/bin/aria2c --input-file=/tmp/queue\n`;
    expect(watchProcessPids(ps, script)).toEqual([3]);
  });

  it("distinguishes an exact mount from a similarly named volume", () => {
    const output = "/dev/disk4s2 on /Volumes/AIARK 1 (exfat, local)\n" +
      "/dev/disk5s1 on /Volumes/OTHER (exfat, local)\n";
    expect(mountedAt(output, "/Volumes/AIARK")).toBe(false);
    expect(mountedAt(`/dev/disk4s2 on /Volumes/AIARK (exfat, local)\n${output}`, "/Volumes/AIARK")).toBe(true);
  });
});

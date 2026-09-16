import { describe, expect, it } from "vitest";
import path from "node:path";
import { downloadProcessPids, pendingPublicFiles, queueText, validateDisk } from "../scripts/vault-watchdog.mjs";

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
});

import { describe, expect, it } from "vitest";
import { RuntimeManager } from "../src/core/runtime";
import { HardwareProfile, RuntimeCatalog } from "../src/core/types";

const hardware: HardwareProfile = {
  platform: "darwin", release: "test", arch: "arm64", hostname: "test", cpuModel: "M2", cpuCores: 8,
  ramBytes: 8 * 1024 ** 3,
  gpus: [{ name: "M2", vendor: "apple", vramBytes: 8 * 1024 ** 3, accelerator: "metal", unifiedMemory: true }],
  detectedAt: new Date(0).toISOString(),
};

const catalog: RuntimeCatalog = {
  schemaVersion: 1,
  runtimes: [{
    id: "llama.cpp",
    name: "llama.cpp",
    releasesApi: "https://example.test/releases",
    executable: { darwin: "llama-cli", linux: "llama-cli", win32: "llama-cli.exe" },
    assets: [{ platform: "darwin", arch: "arm64", accelerator: "metal", pattern: "^llama-macos-arm64\\.tar\\.gz$" }],
  }],
};

describe("RuntimeManager", () => {
  it("selects a platform-native asset with a publisher digest", async () => {
    const fetcher = async () => new Response(JSON.stringify([{
      tag_name: "b1234", draft: false,
      assets: [{ name: "llama-macos-arm64.tar.gz", browser_download_url: "https://example.test/llama.tar.gz", size: 42, digest: `sha256:${"a".repeat(64)}` }],
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
    const plan = await new RuntimeManager(catalog, fetcher).plan("llama.cpp", hardware);
    expect(plan).toMatchObject({ version: "b1234", accelerator: "metal", sha256: "a".repeat(64) });
  });
});

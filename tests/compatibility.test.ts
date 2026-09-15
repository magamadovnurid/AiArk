import { describe, expect, it } from "vitest";
import { assessModelCompatibility } from "../src/core/catalog";
import { HardwareProfile, ModelManifestEntry } from "../src/core/types";

const model: ModelManifestEntry = {
  id: "test-7b",
  name: "Test 7B",
  family: "Test",
  parameterCount: "7B",
  quantization: "Q4_K_M",
  format: "gguf",
  license: "test",
  source: "https://example.test/model",
  runtime: "llama.cpp",
  tags: [],
  requirements: { minRamGb: 8, recommendedRamGb: 16, minVramGb: 6, accelerators: ["metal", "cuda"] },
  artifact: { url: "https://example.test/model.gguf", fileName: "model.gguf", sizeBytes: 1, sha256: "0".repeat(64) },
};

function hardware(ramGb: number, vramGb: number): HardwareProfile {
  return {
    platform: "darwin",
    release: "test",
    arch: "arm64",
    hostname: "test",
    cpuModel: "Apple M",
    cpuCores: 8,
    ramBytes: ramGb * 1024 ** 3,
    gpus: [{ name: "Apple GPU", vendor: "apple", vramBytes: vramGb * 1024 ** 3, accelerator: "metal", unifiedMemory: true }],
    detectedAt: new Date(0).toISOString(),
  };
}

describe("model compatibility", () => {
  it("recommends a model with enough unified memory", () => {
    expect(assessModelCompatibility(model, hardware(24, 24)).status).toBe("recommended");
  });

  it("marks a model incompatible below minimum RAM", () => {
    expect(assessModelCompatibility(model, hardware(4, 4)).status).toBe("incompatible");
  });
});

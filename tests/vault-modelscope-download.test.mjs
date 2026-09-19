import { describe, expect, it } from "vitest";
import { mirrorFilePlan } from "../scripts/vault-modelscope-download.mjs";

const root = "/Volumes/AIARK/AIARK";
const revision = "d99b96521cc01ff8887604f9a083deba33707df9";
const paths = [".gitattributes", "README.md", "added_tokens.json", "chat_template.json", "config.json",
  "generation_config.json", ...Array.from({ length: 5 }, (_, i) => `model-0000${i + 1}-of-00005.safetensors`),
  "model.safetensors.index.json", "preprocessor_config.json", "processor_config.json",
  "special_tokens_map.json", "tokenizer.json", "tokenizer.model", "tokenizer_config.json"];

function fixtures() {
  const manifest = { packages: [{ id: "ltx-2.3-gemma-encoder", gated: true,
    repository: "google/gemma-3-12b-it-qat-q4_0-unquantized",
    revision: "68f7ee4fbd59087436ada77ed2d62f373fdd4482",
    files: paths.map((name) => ({ path: name, sizeBytes: 1,
      destination: `${root}/models/video/ltx-2.3-gemma-encoder/${name}` })) }] };
  const mirror = paths.slice(1).map((name) => ({ Path: name, Size: 1, Sha256: "a".repeat(64), Revision: revision }));
  const google = paths.map((name) => ({ path: name, size: 1,
    oid: name === ".gitattributes" ? "8520ea7c1ebe287a3cf516c16a72b8a899f0f127" : "b".repeat(40) }));
  return { manifest, mirror, google };
}

describe("Gemma ModelScope mirror", () => {
  it("accepts a pinned, exact-size mirror and retains SHA-256 for every file", () => {
    const { manifest, mirror, google } = fixtures();
    const files = mirrorFilePlan(manifest, mirror, google, root);
    expect(files).toHaveLength(18);
    expect(files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(files[1].url).toContain("modelscope.cn/api/v1/models/Lightricks/");
    expect(files.every((file) => file.sha256.length === 64)).toBe(true);
  });

  it("rejects mismatched weights, revisions, and paths outside the ark", () => {
    const { manifest, mirror, google } = fixtures();
    mirror[6].Sha256 = "invalid";
    expect(() => mirrorFilePlan(manifest, mirror, google, root)).toThrow(/Mirror metadata/);
    mirror[6].Sha256 = "a".repeat(64);
    mirror[6].Revision = "other";
    expect(() => mirrorFilePlan(manifest, mirror, google, root)).toThrow(/Mirror metadata/);
    mirror[6].Revision = revision;
    manifest.packages[0].files[6].destination = "/tmp/escape";
    expect(() => mirrorFilePlan(manifest, mirror, google, root)).toThrow(/Unsafe/);
  });
});

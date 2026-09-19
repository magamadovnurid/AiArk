import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../scripts/vault-inventory.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

describe("vault inventory", () => {
  it("reports missing, partial, present, and gated files without reading their contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiark-inventory-"));
    try {
      await fs.mkdir(path.join(root, "models"));
      await fs.writeFile(path.join(root, "models", "ready"), "ready");
      await fs.writeFile(path.join(root, "models", "working"), "work");
      await fs.writeFile(path.join(root, "models", "working.aria2"), "control");
      const file = (name, sizeBytes, hash = null) => ({ destination: path.join(root, "models", name), sizeBytes, sha256: hash });
      const manifest = { schemaVersion: 1, profile: "test", packages: [
        { id: "public", gated: false, files: [file("ready", 5, sha("ready")), file("working", 4), file("absent", 10)] },
        { id: "licensed", gated: true, files: [file("gated", 20)] },
      ] };
      const report = await buildInventory(manifest, root);
      expect(report.files.map((entry) => entry.status)).toEqual(["present", "partial", "missing", "missing"]);
      expect(report.summary).toMatchObject({ files: 4, expectedBytes: 39, observedBytes: 9,
        completeBytes: 5, present: 1, partial: 1, missing: 2, gatedFiles: 1, gatedExpectedBytes: 20,
        hashAvailableFiles: 1, hashCheckedFiles: 0 });
      expect(report.files[0].path).toBe(path.join("models", "ready"));
      const completed = await buildInventory(manifest, root, { completedPaths: new Set([path.join(root, "models", "working")]) });
      expect(completed.files[1].status).toBe("present");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("verifies matching hashes and identifies corruption only when requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiark-inventory-"));
    try {
      await fs.writeFile(path.join(root, "good"), "good");
      await fs.writeFile(path.join(root, "bad"), "bad!");
      const manifest = { schemaVersion: 1, packages: [{ id: "files", files: [
        { destination: path.join(root, "good"), sizeBytes: 4, sha256: sha("good") },
        { destination: path.join(root, "bad"), sizeBytes: 4, sha256: sha("different") },
      ] }] };
      const report = await buildInventory(manifest, root, { verifySha256: true });
      expect(report.files.map((entry) => entry.status)).toEqual(["verified", "corrupt"]);
      expect(report.summary).toMatchObject({ verified: 1, corrupt: 1, completeBytes: 4, hashCheckedFiles: 2 });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rejects destinations outside the ark and duplicate manifest entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiark-inventory-"));
    try {
      const valid = { destination: path.join(root, "model"), sizeBytes: 1 };
      const wrap = (files) => ({ schemaVersion: 1, packages: [{ id: "test", files }] });
      await expect(buildInventory(wrap([{ ...valid, destination: path.join(root, "..", "escape") }]), root)).rejects.toThrow(/leaves ark/);
      await expect(buildInventory(wrap([valid, valid]), root)).rejects.toThrow(/Duplicate/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

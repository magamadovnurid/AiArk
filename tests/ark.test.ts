import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPreparedArk, prepareArk, previewPreparation } from "../src/core/ark";
import { DiskAssessment, ModelCatalog } from "../src/core/types";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

async function fixture(): Promise<DiskAssessment> {
  const mountPoint = await mkdtemp(path.join(os.tmpdir(), "aiark-test-"));
  temporary.push(mountPoint);
  return {
    disk: {
      id: "test-disk",
      devicePath: "/dev/test-disk",
      name: "Test",
      sizeBytes: 4_000_000_000_000,
      bus: "USB",
      external: true,
      removable: true,
      partitionScheme: "gpt",
      systemDisk: false,
      fingerprint: "FINGERPRINT",
      volumes: [],
    },
    eligibleSize: true,
    recommendedFormat: true,
    recommendedScheme: true,
    mountedWritableVolume: { id: "v1", name: "AIARK", mountPoint, filesystem: "exfat", writable: true, sizeBytes: 4_000_000_000_000, freeBytes: 4_000_000_000_000 },
    canPrepare: true,
    warnings: [],
    confirmation: "PREPARE AIARK FINGERPRINT",
  };
}

const catalog: ModelCatalog = { schemaVersion: 1, generatedAt: new Date(0).toISOString(), models: [] };

describe("ark preparation", () => {
  it("previews without writing and prepares only after exact confirmation", async () => {
    const assessment = await fixture();
    const preview = previewPreparation(assessment);
    expect(preview.dryRun).toBe(true);
    await expect(readFile(path.join(assessment.mountedWritableVolume!.mountPoint!, "AIARK", "ark.json"))).rejects.toThrow();
    await expect(prepareArk(assessment, "wrong", catalog)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const result = await prepareArk(assessment, assessment.confirmation, catalog);
    const metadata = JSON.parse(await readFile(path.join(result.root, "ark.json"), "utf8"));
    expect(metadata).toMatchObject({ label: "AIARK", diskFingerprint: "FINGERPRINT" });
  });

  it("will not adopt a pre-existing foreign AIARK directory", async () => {
    const assessment = await fixture();
    await mkdir(path.join(assessment.mountedWritableVolume!.mountPoint!, "AIARK"));
    await expect(prepareArk(assessment, assessment.confirmation, catalog)).rejects.toMatchObject({ code: "FOREIGN_DIRECTORY" });
  });

  it("recognizes only an ark prepared for the connected disk", async () => {
    const assessment = await fixture();
    expect(await inspectPreparedArk(assessment)).toMatchObject({ prepared: false });
    const result = await prepareArk(assessment, assessment.confirmation, catalog);
    expect(await inspectPreparedArk(assessment)).toEqual({ prepared: true, root: result.root });
    assessment.disk.fingerprint = "ANOTHER-DISK";
    expect(await inspectPreparedArk(assessment)).toEqual({ prepared: false, root: result.root });
  });
});

#!/usr/bin/env node
import path from "node:path";
import {
  AiArkError,
  DiskManager,
  HardwareDetector,
  ModelManager,
  RuntimeManager,
  buildCompatibilityMatrix,
  discoverClusterPeers,
  launchModel,
  loadModelCatalog,
  loadRuntimeCatalog,
  prepareArk,
  previewPreparation,
} from "./core";

const HELP = `AiArk Portable AI Ark

Usage:
  aiark scan [--json]
  aiark disk preview --disk <id|fingerprint> [--json]
  aiark disk format-preview --disk <id|fingerprint> [--json]
  aiark disk prepare --disk <id|fingerprint> --confirm "PREPARE AIARK …" [--json]
  aiark catalog [--json]
  aiark recommend [--json]
  aiark model download <model-id> --ark <AIARK path>
  aiark model verify <model-id> --ark <AIARK path> [--json]
  aiark model repair <model-id> --ark <AIARK path>
  aiark runtime plan <runtime-id> [--json]
  aiark runtime install <runtime-id>
  aiark cluster discover [--timeout <ms>] [--json]
  aiark launch --runtime <executable> --model <gguf> [--prompt <text>]

Safety: AiArk never formats a disk. The format-preview command only explains the
recommended GPT + ExFAT operation. Preparation requires the exact per-disk token.`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function print(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

async function selectedAssessment(selector: string | undefined) {
  if (!selector) throw new AiArkError("--disk is required", "MISSING_ARGUMENT");
  const manager = new DiskManager();
  const disks = await manager.detectExternalDisks();
  const disk = disks.find((candidate) => candidate.id === selector || candidate.fingerprint === selector.toUpperCase());
  if (!disk) throw new AiArkError(`External disk not found: ${selector}`, "DISK_NOT_FOUND");
  return { manager, assessment: manager.assess(disk) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const [command, action, target] = args;
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  if (command === "scan") {
    const [hardware, catalog, disks] = await Promise.all([
      new HardwareDetector().detect(),
      loadModelCatalog(),
      new DiskManager().detectExternalDisks(),
    ]);
    const manager = new DiskManager();
    print({ hardware, disks: disks.map((disk) => manager.assess(disk)), compatibility: buildCompatibilityMatrix(catalog, hardware) }, true);
    return;
  }

  if (command === "disk" && action === "preview") {
    const { assessment } = await selectedAssessment(option(args, "--disk"));
    print(previewPreparation(assessment), json);
    return;
  }
  if (command === "disk" && action === "format-preview") {
    const { manager, assessment } = await selectedAssessment(option(args, "--disk"));
    print(manager.formatPreview(assessment.disk), json);
    return;
  }
  if (command === "disk" && action === "prepare") {
    const { assessment } = await selectedAssessment(option(args, "--disk"));
    const confirmation = option(args, "--confirm") ?? "";
    const result = await prepareArk(assessment, confirmation, await loadModelCatalog());
    print(result, json);
    return;
  }

  if (command === "catalog") {
    print(await loadModelCatalog(), json);
    return;
  }
  if (command === "recommend") {
    const [hardware, catalog] = await Promise.all([new HardwareDetector().detect(), loadModelCatalog()]);
    print(buildCompatibilityMatrix(catalog, hardware), json);
    return;
  }

  if (command === "model" && ["download", "verify", "repair"].includes(action ?? "")) {
    if (!target) throw new AiArkError("Model id is required", "MISSING_ARGUMENT");
    const root = option(args, "--ark");
    if (!root) throw new AiArkError("--ark is required", "MISSING_ARGUMENT");
    const manager = new ModelManager(await loadModelCatalog());
    if (action === "verify") {
      print(await manager.verify(target, path.resolve(root)), json);
      return;
    }
    const onProgress = (progress: { downloadedBytes: number; totalBytes: number }) => {
      if (!json) process.stderr.write(`\r${(progress.downloadedBytes / 1024 ** 2).toFixed(1)} / ${(progress.totalBytes / 1024 ** 2).toFixed(1)} MiB`);
    };
    const result = action === "download"
      ? await manager.download(target, path.resolve(root), { onProgress })
      : await manager.repair(target, path.resolve(root), { onProgress });
    if (!json) process.stderr.write("\n");
    print(result, json);
    return;
  }

  if (command === "runtime" && ["plan", "install"].includes(action ?? "")) {
    if (!target) throw new AiArkError("Runtime id is required", "MISSING_ARGUMENT");
    const [hardware, catalog] = await Promise.all([new HardwareDetector().detect(), loadRuntimeCatalog()]);
    const manager = new RuntimeManager(catalog);
    const plan = await manager.plan(target, hardware);
    if (action === "plan") print(plan, json);
    else print(await manager.install(plan, hardware, {
      onProgress(progress) {
        if (!json) process.stderr.write(`\r${(progress.downloadedBytes / 1024 ** 2).toFixed(1)} / ${(progress.totalBytes / 1024 ** 2).toFixed(1)} MiB`);
      },
    }), json);
    return;
  }

  if (command === "cluster" && action === "discover") {
    const timeoutMs = Number(option(args, "--timeout") ?? 1500);
    print(await discoverClusterPeers(await new HardwareDetector().detect(), timeoutMs), json);
    return;
  }

  if (command === "launch") {
    const runtimeExecutable = option(args, "--runtime");
    const modelPath = option(args, "--model");
    if (!runtimeExecutable || !modelPath) throw new AiArkError("--runtime and --model are required", "MISSING_ARGUMENT");
    process.exitCode = await launchModel({
      runtimeExecutable: path.resolve(runtimeExecutable),
      modelPath: path.resolve(modelPath),
      prompt: option(args, "--prompt"),
      mode: args.includes("--server") ? "server" : "chat",
      port: Number(option(args, "--port") ?? 8080),
    });
    return;
  }

  throw new AiArkError(`Unknown command: ${args.join(" ")}`, "UNKNOWN_COMMAND");
}

main().catch((error) => {
  const code = error instanceof AiArkError ? error.code : "UNEXPECTED_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: code, message }, null, 2));
  process.exitCode = 1;
});

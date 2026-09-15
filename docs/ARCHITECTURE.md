# Architecture

AiArk uses one platform-neutral TypeScript core from two shells: the Electron desktop app and the CLI. No safety or download logic is duplicated in the renderer.

```text
Desktop UI ─┐
            ├── core orchestrators ── hardware detector
CLI ────────┘                      ├── disk manager + ark preparer
                                  ├── catalog + compatibility engine
                                  ├── model manager + chunk downloader
                                  ├── runtime manager + launcher
                                  └── cluster discovery
```

## Modules

- `hardware.ts` uses native read-only platform probes, including `system_profiler`, `nvidia-smi`, `lspci`, and Windows CIM.
- `disk.ts` normalizes physical disks and mounted volumes into one schema. Eligibility and warnings are pure assessment logic.
- `ark.ts` owns dry-run output, confirmation, root-marker checks, and idempotent creation of the storage tree.
- `catalog.ts` validates the bundled catalog version and produces ranked, explainable compatibility results.
- `download.ts` probes HTTP range support, validates reusable chunks, downloads with bounded concurrency and retry, atomically assembles, and verifies SHA-256.
- `model.ts` maps catalog entries to safe paths under `AIARK/models` and updates `library/index.json` only after verification.
- `runtime.ts` chooses a native `llama.cpp` release for the detected accelerator. Archives and installations live in local app data, not on ExFAT.
- `launcher.ts` passes arguments directly to a local runtime without a shell.
- `cluster.ts` sends a minimal versioned UDP multicast announcement. It does not expose a control plane.

## Trust boundaries

The renderer is sandboxed, has no Node.js access, and can call only a fixed preload API. Disk identity and eligibility are recalculated in the main process immediately before preparation. Manifest filenames are reduced to basenames, archives are inspected for absolute and parent-traversal paths, and model/runtime bytes are promoted from temporary paths only after SHA-256 verification.

## Data placement

Portable data belongs on the ark: models, catalog snapshots, library records, datasets, and download state. Executables and platform libraries belong in native local app-data directories:

- macOS: `~/Library/Application Support/AiArk/runtimes`
- Windows: `%LOCALAPPDATA%\AiArk\runtimes`
- Linux: `$XDG_DATA_HOME/aiark/runtimes` or `~/.local/share/aiark/runtimes`

This split avoids ExFAT permission and symlink limitations and prevents one platform's binaries from being mistaken for another's.

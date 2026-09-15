# AiArk Portable AI Ark

AiArk turns a large external drive into a portable, verified library of AI model files while keeping native runtimes on each computer. The same ark can travel between macOS, Windows, and Linux; AiArk detects the current hardware and recommends only models that fit.

> **Safety first:** AiArk 0.1 never formats a disk. Scans and previews are read-only. Preparing an already-compatible disk requires an exact per-disk confirmation token and creates only the `AIARK/` directory tree.

## What the MVP does

- detects external disks on macOS (`diskutil`), Linux (`lsblk`), and Windows (PowerShell/CIM);
- requires the universal profile: **4 TB decimal or larger + GPT + ExFAT + writable mount**;
- fingerprints the selected physical disk and rescans it immediately before a write;
- detects OS, architecture, CPU, RAM, GPU, VRAM/unified memory, and accelerator backend;
- builds an explainable model compatibility matrix;
- loads a versioned model manifest with source URL, size, runtime, license, and SHA-256;
- downloads in parallel HTTP ranges, resumes complete chunks, verifies SHA-256, and repairs known corrupt chunks;
- stores model files and manifests on the ark while installing `llama.cpp` in local app data;
- resolves current platform-native runtime assets from GitHub releases and requires the publisher SHA-256 digest;
- discovers other AiArk nodes through local-network multicast without enabling remote execution;
- provides both an Electron desktop interface and a scriptable CLI.

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

For the CLI:

```bash
npm run build
node dist/cli.js scan --json
node dist/cli.js disk preview --disk <disk-id>
```

The preview returns a disk-specific phrase such as `PREPARE AIARK A1B2C3D4E5F6`. Preparation is allowed only when that exact phrase is supplied:

```bash
node dist/cli.js disk prepare \
  --disk <disk-id> \
  --confirm "PREPARE AIARK A1B2C3D4E5F6"
```

AiArk will still refuse if the disk is too small, is internal/system storage, is not GPT, is not ExFAT, is read-only, has been disconnected, or its fingerprint changed.

## Ark layout

```text
AIARK/
├── ark.json                     # stable ark id + physical-disk fingerprint
├── .aiark/
│   ├── downloads/               # reserved download state
│   ├── checksums/
│   └── logs/
├── manifests/catalog.json       # catalog snapshot used to build this ark
├── library/index.json           # installed and last-verified model records
├── models/
│   ├── gguf/
│   ├── onnx/
│   └── safetensors/
├── datasets/
├── exports/
└── docs/
```

Download state is kept next to the destination model in a hidden `.aiark-downloads` directory so an interrupted transfer can continue on another run.

## Common CLI workflows

```bash
# Hardware + disks + compatibility
node dist/cli.js scan --json

# Catalog and recommendations
node dist/cli.js catalog --json
node dist/cli.js recommend --json

# Explain GPT + ExFAT formatting without doing it
node dist/cli.js disk format-preview --disk <disk-id> --json

# Download, verify, or repair a model
node dist/cli.js model download tinyllama-1.1b-chat-q4_k_m --ark /path/to/AIARK
node dist/cli.js model verify tinyllama-1.1b-chat-q4_k_m --ark /path/to/AIARK
node dist/cli.js model repair tinyllama-1.1b-chat-q4_k_m --ark /path/to/AIARK

# Resolve/install a native runtime locally
node dist/cli.js runtime plan llama.cpp --json
node dist/cli.js runtime install llama.cpp

# Discover peers on the same LAN
node dist/cli.js cluster discover --timeout 2000 --json
```

Set `HF_TOKEN` in the process environment for authenticated Hugging Face downloads. It is used only as an HTTP authorization header and is never written to the ark.

## Development and builds

```bash
npm run check       # strict TypeScript, unit/integration tests, bundles
npm run dist:dir    # unpacked app for the current platform
npm run dist        # native installer(s) for the current platform
```

GitHub Actions validates the project and packages native artifacts on macOS, Windows, and Linux. Cross-platform desktop apps must be built on their target operating system; the workflow handles that matrix.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Disk and write safety](docs/SAFETY.md)
- [Model manifest format](docs/MODEL_MANIFEST.md)
- [MVP boundaries and roadmap](docs/ROADMAP.md)

## Status

This is a functional first MVP, not a promise that every model fits every machine. The compatibility result is deliberately explainable, and model licensing remains the operator's responsibility. See the roadmap before using AiArk as production infrastructure.

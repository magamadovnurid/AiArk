# Changelog

All notable changes to AiArk are documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while the public API remains in `0.x` development.

## [Unreleased]

## [0.1.0] - 2026-09-15

### Added

- Cross-platform Electron desktop application and CLI.
- External disk discovery for Windows, macOS, and Linux.
- Read-only preparation preview, per-disk fingerprint, and exact confirmation requirement.
- Universal GPT + ExFAT + 4 TB eligibility profile without automatic formatting.
- CPU, RAM, GPU, VRAM, architecture, and accelerator detection.
- Versioned model catalog and explainable compatibility ranking.
- Parallel chunked downloads with retry, resume, SHA-256 verification, and repair.
- Portable model library structure with platform-native local runtime installation.
- `llama.cpp` runtime resolution and verified installation.
- Local-network AiArk peer discovery without remote execution.
- Minimal Russian desktop workflow with automatic single-disk selection.
- Automated validation and native packaging for Windows, macOS, and Linux.

### Security

- Sandboxed renderer with a fixed preload API.
- Path traversal and unsafe archive-entry protections.
- Reassessment of disk identity and eligibility immediately before preparation.
- Publisher checksum requirements for model and runtime artifacts.

[Unreleased]: https://github.com/magamadovnurid/AiArk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/magamadovnurid/AiArk/releases/tag/v0.1.0

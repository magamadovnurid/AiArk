# Contributing to AiArk

AiArk touches physical disks, large downloads, and executable supply-chain inputs. Contributions are welcome, but safety behavior must remain explicit and testable.

## Development setup

Requirements:

- Node.js 20 or newer;
- npm;
- Windows, macOS, or Linux for native desktop packaging tests.

```bash
git clone https://github.com/magamadovnurid/AiArk.git
cd AiArk
npm ci
npm run check
npm run dev
```

Create a focused branch, add tests with the change, and open a pull request against `main`. Use Conventional Commit-style messages when practical, for example `feat: add Vulkan detection` or `fix: reject changed disk fingerprint`.

## Required safety invariants

Changes must not weaken these rules:

1. Scanning and previews perform no writes.
2. Formatting never starts without a separate, explicit, destructive confirmation flow.
3. Preparation targets only an external, non-system disk that still matches its fingerprint.
4. AiArk never adopts a pre-existing foreign `AIARK/` directory.
5. Model and runtime downloads are promoted only after checksum verification.
6. Archive extraction rejects absolute paths, parent traversal, and unsafe entries.
7. The renderer remains sandboxed and receives only the minimum required IPC surface.
8. Tokens and credentials are never written to the ark, logs, fixtures, or repository.

Add or update tests whenever a change affects one of these boundaries.

## Model catalog changes

Every model entry must include a stable HTTPS source, exact byte size, SHA-256 checksum, model license, runtime, format, and realistic minimum/recommended requirements. Do not guess checksums or license terms. Review [the manifest specification](docs/MODEL_MANIFEST.md) before editing `config/models.json`.

## Platform changes

Keep platform-specific commands inside the relevant detector or manager. Do not parse human-oriented command output when a structured JSON, plist, or PowerShell object format exists. Mention the operating systems and architectures tested in the pull request.

## Before opening a pull request

```bash
npm run check
npm audit --omit=dev
```

Do not commit `release/`, application data, downloaded models, tokens, disk identifiers, or private URLs. Security vulnerabilities belong in a private [GitHub Security Advisory](https://github.com/magamadovnurid/AiArk/security/advisories/new), not a public issue.

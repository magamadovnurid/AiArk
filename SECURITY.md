# Security policy

## Supported versions

| Version | Security updates |
|---|---|
| Latest `0.x` release | Yes |
| Older pre-releases | No |

AiArk is an early-stage project. Update to the newest release before reporting an issue that may already be resolved.

## Report a vulnerability privately

Use GitHub's private [Report a vulnerability](https://github.com/magamadovnurid/AiArk/security/advisories/new) form. Include the affected version, operating system, impact, reproduction steps, and a minimal proof of concept. Remove access tokens, private model URLs, disk serial numbers, fingerprints, and personal data.

Do not open a public issue for vulnerabilities involving disk selection or writes, path traversal, archive extraction, checksum bypass, token exposure, IPC privilege boundaries, or remote-network behavior. Acknowledgement and remediation timing depend on severity and maintainer availability; no public SLA is promised during the MVP phase.

## Security model

- AiArk does not require administrator privileges for its normal workflow.
- Version `0.1.x` contains no automatic disk-format implementation.
- Disk identity and eligibility are recalculated immediately before preparation.
- The Electron renderer is sandboxed and has no direct Node.js access.
- Model files and runtime archives are treated as untrusted supply-chain inputs.
- Files are promoted from temporary storage only after SHA-256 verification.
- Cluster discovery advertises minimal capability metadata and exposes no remote-execution endpoint.
- `HF_TOKEN` is read from the process environment and is never intentionally persisted.

Release binaries in the `0.x` series are currently unsigned. Download them only from this repository's Releases page, compare `SHA256SUMS.txt`, and use GitHub's build-provenance attestation when available.

Never commit tokens, signing certificates, private model URLs, captured disk identities, or vulnerability proofs.

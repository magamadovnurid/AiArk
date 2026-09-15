# MVP boundaries and roadmap

## Version 0.1 boundaries

- Disk formatting is preview/documentation-only by design.
- The bundled runtime catalog contains `llama.cpp`; the architecture supports more runtime definitions later.
- Cluster discovery identifies peers but does not transfer models, schedule jobs, or execute remote commands.
- Model manifests are bundled with the application; signed remote catalog updates are not yet implemented.
- Compatibility is a conservative rules engine, not a benchmark. Context length, batch size, thermals, and memory shared with other applications still affect real performance.
- Code signing/notarization credentials are not included. CI produces unsigned artifacts unless repository secrets are configured.

## Next milestones

1. Signed catalog updates with pinned publisher keys and revocation support.
2. Benchmark calibration that records tokens/second without uploading hardware identity.
3. Resumable peer-to-peer model transfer with mutual authorization and chunk proofs.
4. Runtime health checks and one-click launch profiles for chat/server modes.
5. Optional privileged formatting helper with device re-enumeration, backup warnings, a second physical confirmation, and platform-native authorization.
6. Accessibility/localization pass and signed/notarized release channels.

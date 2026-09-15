# Security policy

Please report vulnerabilities privately to the repository owner rather than opening a public issue with exploit details.

AiArk does not require administrative privileges for its normal workflow. Version 0.1 has no disk-format implementation and no remote-execution endpoint. Treat model files and runtime archives as supply-chain inputs: retain publisher checksums, review catalog changes, and do not disable checksum verification.

Never commit `HF_TOKEN`, signing credentials, or private model access tokens. AiArk reads `HF_TOKEN` from the current process environment only.

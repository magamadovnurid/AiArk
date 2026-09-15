# Disk and write safety

AiArk treats physical-disk operations as a separate trust boundary.

## Default behavior

Scanning, hardware detection, compatibility calculation, preparation preview, format preview, runtime planning, and model verification are non-destructive. `disk format-preview` returns an explanation and a destructive-looking confirmation phrase, but this MVP contains no format executor.

## Preparation gates

Creating the ark directory tree requires all of the following at the same time:

1. the device is detected as external and is not a system/boot disk;
2. physical capacity is at least 4,000,000,000,000 bytes;
3. the partition table is GPT/GUID;
4. a mounted ExFAT data volume is writable;
5. the user supplies `PREPARE AIARK <fingerprint>` exactly;
6. a fresh scan still resolves the same physical-disk fingerprint;
7. `AIARK/` either does not exist or contains a valid `ark.json` for that fingerprint.

AiArk will not adopt a pre-existing unmarked `AIARK/` directory. This avoids silently mixing managed files with user content.

## Recommended format

For an ark intended to move between Windows, macOS, and Linux, use one **ExFAT** data volume on a **GUID Partition Table (GPT)**. ExFAT supports model files larger than 4 GB and is writable on all three target platforms. APFS, HFS+, NTFS, and ext4 are useful in narrower environments but do not satisfy the universal profile without extra drivers.

Formatting erases the selected physical disk. Back up its contents and use the operating system's own disk utility to select the whole external device, GPT/GUID, ExFAT, and the label `AIARK`. Disconnect other removable drives first. AiArk intentionally does not automate these steps in version 0.1.

## Recovery behavior

- Interrupted ranged downloads keep complete verified-size chunks and resume later.
- A completed model is installed only after its full SHA-256 matches the manifest.
- If per-chunk hashes exist, repair replaces only failed chunks and rechecks the full file.
- If only a whole-file hash exists, repair performs a new verified download and preserves the old file with a `.corrupt-<timestamp>` suffix.
- Runtime installation requires the SHA-256 digest published in the GitHub release asset metadata.

No credential value is written to logs, metadata, or the external drive.

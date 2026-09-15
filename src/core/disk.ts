import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { CommandRunner, systemCommandRunner } from "./command";
import { AiArkError } from "./errors";
import { parsePlist } from "./plist";
import { DiskAssessment, DiskVolume, ExternalDisk, Platform } from "./types";

export const MINIMUM_ARK_BYTES = 4_000_000_000_000;

type AnyRecord = Record<string, unknown>;

function supportedPlatform(value: NodeJS.Platform): Platform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new AiArkError(`Unsupported platform: ${value}`, "UNSUPPORTED_PLATFORM");
}

function fingerprint(platform: Platform, id: string, size: number, scheme: string | null, identity = ""): string {
  return createHash("sha256").update(`${platform}:${id}:${size}:${scheme ?? "none"}:${identity}`).digest("hex").slice(0, 12).toUpperCase();
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function normalizeFilesystem(value: unknown): string | null {
  const name = String(value ?? "").trim().toLowerCase();
  if (!name) return null;
  if (name === "exfat" || name.includes("exfat")) return "exfat";
  if (name === "ntfs" || name.includes("ntfs")) return "ntfs";
  if (name.includes("apfs")) return "apfs";
  if (name.includes("ext4")) return "ext4";
  return name;
}

async function availableBytes(mountPoint: string | null): Promise<number | null> {
  if (!mountPoint) return null;
  try {
    const stats = await statfs(mountPoint);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export class DiskManager {
  constructor(
    private readonly runner: CommandRunner = systemCommandRunner,
    private readonly platform: Platform = supportedPlatform(process.platform),
  ) {}

  async detectExternalDisks(): Promise<ExternalDisk[]> {
    if (this.platform === "darwin") return this.detectMacDisks();
    if (this.platform === "linux") return this.detectLinuxDisks();
    return this.detectWindowsDisks();
  }

  assess(disk: ExternalDisk): DiskAssessment {
    const eligibleSize = disk.sizeBytes >= MINIMUM_ARK_BYTES;
    const recommendedScheme = /guid|gpt/i.test(disk.partitionScheme ?? "");
    const mountedVolume = [...disk.volumes]
      .filter((volume) => volume.mountPoint)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ?? null;
    const mountedWritableVolume = [...disk.volumes]
      .filter((volume) => volume.mountPoint && volume.writable)
      .sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ?? null;
    const recommendedFormat = mountedVolume?.filesystem === "exfat";
    const warnings: string[] = [];
    if (!disk.external || disk.systemDisk) warnings.push("Disk is not a safe external target.");
    if (!eligibleSize) warnings.push("AiArk requires a disk of at least 4 TB (decimal).");
    if (!recommendedScheme) warnings.push("GUID Partition Table (GPT) is recommended.");
    if (!mountedWritableVolume) warnings.push("No mounted writable data volume was found.");
    if (mountedVolume && !recommendedFormat) {
      warnings.push(`Volume filesystem is ${mountedVolume.filesystem ?? "unknown"}; ExFAT is required for the universal portable profile.`);
    }
    if (mountedVolume && !mountedVolume.writable) {
      warnings.push(`Volume ${mountedVolume.name} is read-only on this operating system.`);
    }
    const canPrepare = disk.external && !disk.systemDisk && eligibleSize && recommendedScheme && recommendedFormat && Boolean(mountedWritableVolume);
    return {
      disk,
      eligibleSize,
      recommendedFormat,
      recommendedScheme,
      mountedWritableVolume,
      canPrepare,
      warnings,
      confirmation: `PREPARE AIARK ${disk.fingerprint}`,
    };
  }

  formatPreview(disk: ExternalDisk): { confirmation: string; target: string; summary: string[] } {
    return {
      confirmation: `FORMAT AIARK ${disk.fingerprint}`,
      target: disk.devicePath,
      summary: [
        `Erase every partition on ${disk.devicePath} (${disk.name}).`,
        "Create a GUID Partition Table (GPT).",
        "Create one ExFAT volume named AIARK.",
        "This operation is intentionally not executed by the MVP.",
      ],
    };
  }

  private async detectMacDisks(): Promise<ExternalDisk[]> {
    const listing = await this.runner.run("diskutil", ["list", "-plist", "external", "physical"]);
    if (listing.exitCode !== 0) throw new AiArkError("Unable to list macOS disks", "DISK_SCAN_FAILED", listing.stderr);
    const parsed = parsePlist(listing.stdout);
    const disks = asArray(parsed.AllDisksAndPartitions).map(asRecord);
    return Promise.all(disks.map(async (record) => {
      const id = String(record.DeviceIdentifier ?? "");
      const info = await this.macDiskInfo(`/dev/${id}`);
      const partitionRecords = asArray(record.Partitions).map(asRecord);
      const volumes: DiskVolume[] = [];
      for (const partition of partitionRecords) {
        const partitionId = String(partition.DeviceIdentifier ?? "");
        if (!partitionId) continue;
        const partitionInfo = await this.macDiskInfo(`/dev/${partitionId}`);
        const mountPoint = String(partitionInfo.MountPoint ?? "") || null;
        const filesystem = normalizeFilesystem(partitionInfo.FilesystemType ?? partitionInfo.FilesystemName);
        if (!mountPoint && !filesystem) continue;
        volumes.push({
          id: partitionId,
          name: String(partitionInfo.VolumeName ?? partition.VolumeName ?? partitionId),
          mountPoint,
          filesystem,
          writable: Boolean(partitionInfo.WritableVolume),
          sizeBytes: Number(partitionInfo.VolumeSize ?? partition.Size ?? 0),
          freeBytes: Number(partitionInfo.FreeSpace ?? 0) || await availableBytes(mountPoint),
        });
      }
      const sizeBytes = Number(info.TotalSize ?? info.Size ?? record.Size ?? 0);
      const scheme = String(record.Content ?? info.Content ?? "") || null;
      return {
        id,
        devicePath: `/dev/${id}`,
        name: String(info.MediaName ?? info.IORegistryEntryName ?? id),
        sizeBytes,
        bus: String(info.BusProtocol ?? "") || null,
        external: !Boolean(info.Internal) && Boolean(info.RemovableMediaOrExternalDevice ?? true),
        removable: Boolean(info.Removable ?? info.Ejectable),
        partitionScheme: scheme,
        systemDisk: Boolean(info.Internal),
        volumes,
        fingerprint: fingerprint(
          "darwin",
          id,
          sizeBytes,
          scheme,
          partitionRecords.map((partition) => String(partition.DiskUUID ?? partition.VolumeUUID ?? "")).join(":"),
        ),
      };
    }));
  }

  private async macDiskInfo(device: string): Promise<AnyRecord> {
    const result = await this.runner.run("diskutil", ["info", "-plist", device]);
    if (result.exitCode !== 0) return {};
    return parsePlist(result.stdout) as AnyRecord;
  }

  private async detectLinuxDisks(): Promise<ExternalDisk[]> {
    const columns = "NAME,KNAME,PATH,SIZE,MODEL,SERIAL,UUID,TRAN,RM,RO,TYPE,FSTYPE,LABEL,MOUNTPOINT,PKNAME,PTTYPE";
    const result = await this.runner.run("lsblk", ["-J", "-b", "-o", columns]);
    if (result.exitCode !== 0) throw new AiArkError("Unable to list Linux disks", "DISK_SCAN_FAILED", result.stderr);
    const parsed = JSON.parse(result.stdout) as { blockdevices?: AnyRecord[] };
    const rootDevices = parsed.blockdevices ?? [];
    const output: ExternalDisk[] = [];
    for (const raw of rootDevices) {
      const record = asRecord(raw);
      if (String(record.type) !== "disk") continue;
      const children = asArray(record.children).map(asRecord);
      const systemMounts = ["/", "/boot", "/boot/efi"];
      const systemDisk = systemMounts.includes(String(record.mountpoint ?? ""))
        || children.some((child) => systemMounts.includes(String(child.mountpoint ?? "")));
      const external = String(record.tran ?? "").toLowerCase() === "usb" || Number(record.rm) === 1;
      if (!external) continue;
      const volumes: DiskVolume[] = [];
      for (const child of children) {
        const mountPoint = String(child.mountpoint ?? "") || null;
        const filesystem = normalizeFilesystem(child.fstype);
        if (!mountPoint && !filesystem) continue;
        volumes.push({
          id: String(child.kname ?? child.name ?? ""),
          name: String(child.label ?? child.name ?? "volume"),
          mountPoint,
          filesystem,
          writable: Number(child.ro ?? 0) === 0 && Boolean(mountPoint),
          sizeBytes: Number(child.size ?? 0),
          freeBytes: await availableBytes(mountPoint),
        });
      }
      const id = String(record.kname ?? record.name ?? "");
      const sizeBytes = Number(record.size ?? 0);
      const scheme = String(record.pttype ?? "") || null;
      output.push({
        id,
        devicePath: String(record.path ?? `/dev/${id}`),
        name: String(record.model ?? id).trim(),
        sizeBytes,
        bus: String(record.tran ?? "") || null,
        external,
        removable: Number(record.rm) === 1,
        partitionScheme: scheme,
        systemDisk,
        volumes,
        fingerprint: fingerprint("linux", id, sizeBytes, scheme, [record.serial, record.uuid, ...children.map((child) => child.uuid)].map(String).join(":")),
      });
    }
    return output;
  }

  private async detectWindowsDisks(): Promise<ExternalDisk[]> {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$items = Get-Disk | Where-Object { $_.BusType -in @('USB','SD','MMC') } | ForEach-Object {",
      "  $d = $_",
      "  $volumes = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | ForEach-Object {",
      "    $p = $_; $v = $p | Get-Volume -ErrorAction SilentlyContinue",
      "    if ($v) { [PSCustomObject]@{ Id=$p.PartitionNumber; Name=$v.FileSystemLabel; DriveLetter=$v.DriveLetter; FileSystem=$v.FileSystem; Size=$v.Size; Free=$v.SizeRemaining; ReadOnly=$v.IsReadOnly } }",
      "  })",
      "  [PSCustomObject]@{ Number=$d.Number; UniqueId=$d.UniqueId; Name=$d.FriendlyName; Size=$d.Size; BusType=$d.BusType; PartitionStyle=$d.PartitionStyle; IsBoot=$d.IsBoot; IsSystem=$d.IsSystem; IsReadOnly=$d.IsReadOnly; Volumes=$volumes }",
      "}",
      "$items | ConvertTo-Json -Depth 5 -Compress",
    ].join("; ");
    let result = await this.runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (result.exitCode !== 0) result = await this.runner.run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (result.exitCode !== 0) throw new AiArkError("Unable to list Windows disks", "DISK_SCAN_FAILED", result.stderr);
    const records = asArray(result.stdout.trim() ? JSON.parse(result.stdout) : []).map(asRecord);
    return records.map((record) => {
      const id = `PhysicalDrive${Number(record.Number)}`;
      const sizeBytes = Number(record.Size ?? 0);
      const scheme = String(record.PartitionStyle ?? "") || null;
      const volumes = asArray(record.Volumes).map(asRecord).map((volume): DiskVolume => {
        const driveLetter = String(volume.DriveLetter ?? "");
        return {
          id: `${id}:${String(volume.Id ?? "")}`,
          name: String(volume.Name ?? (driveLetter || "volume")),
          mountPoint: driveLetter ? `${driveLetter}:\\` : null,
          filesystem: normalizeFilesystem(volume.FileSystem),
          writable: !Boolean(volume.ReadOnly) && Boolean(driveLetter),
          sizeBytes: Number(volume.Size ?? 0),
          freeBytes: Number(volume.Free ?? 0) || null,
        };
      });
      return {
        id,
        devicePath: `\\\\.\\${id}`,
        name: String(record.Name ?? id),
        sizeBytes,
        bus: String(record.BusType ?? "") || null,
        external: true,
        removable: true,
        partitionScheme: scheme,
        systemDisk: Boolean(record.IsBoot) || Boolean(record.IsSystem),
        volumes,
        fingerprint: fingerprint("win32", id, sizeBytes, scheme, String(record.UniqueId ?? "")),
      };
    });
  }
}

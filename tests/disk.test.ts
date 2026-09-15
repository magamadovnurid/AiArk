import { describe, expect, it } from "vitest";
import { DiskManager } from "../src/core/disk";
import { CommandRunner } from "../src/core/command";
import { ExternalDisk } from "../src/core/types";

function disk(overrides: Partial<ExternalDisk> = {}): ExternalDisk {
  return {
    id: "disk9",
    devicePath: "/dev/disk9",
    name: "Test disk",
    sizeBytes: 4_000_000_000_000,
    bus: "USB",
    external: true,
    removable: true,
    partitionScheme: "gpt",
    systemDisk: false,
    fingerprint: "ABC123",
    volumes: [{
      id: "disk9s1",
      name: "AIARK",
      mountPoint: "/Volumes/AIARK",
      filesystem: "exfat",
      writable: true,
      sizeBytes: 4_000_000_000_000,
      freeBytes: 3_900_000_000_000,
    }],
    ...overrides,
  };
}

describe("DiskManager safety assessment", () => {
  const manager = new DiskManager(undefined, "darwin");

  it("accepts only the complete external GPT + ExFAT profile", () => {
    const result = manager.assess(disk());
    expect(result.canPrepare).toBe(true);
    expect(result.confirmation).toBe("PREPARE AIARK ABC123");
  });

  it("rejects a system disk even if every other field looks valid", () => {
    const result = manager.assess(disk({ systemDisk: true }));
    expect(result.canPrepare).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/not a safe external target/i);
  });

  it("reports NTFS and read-only state", () => {
    const candidate = disk();
    candidate.volumes[0]!.filesystem = "ntfs";
    candidate.volumes[0]!.writable = false;
    const result = manager.assess(candidate);
    expect(result.canPrepare).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/ExFAT/),
      expect.stringMatching(/read-only/),
    ]));
  });

  it("normalizes Linux lsblk output", async () => {
    const runner: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({
      blockdevices: [{ name: "sdb", kname: "sdb", path: "/dev/sdb", size: "4001000000000", model: "Portable", serial: "SERIAL", tran: "usb", rm: 1, ro: 0, type: "disk", pttype: "gpt", children: [
        { name: "sdb1", kname: "sdb1", size: "4000000000000", type: "part", fstype: "exfat", label: "AIARK", mountpoint: null, ro: 0, uuid: "UUID" },
      ] }],
    }) }) };
    const [detected] = await new DiskManager(runner, "linux").detectExternalDisks();
    expect(detected).toMatchObject({ id: "sdb", external: true, partitionScheme: "gpt" });
    expect(detected?.volumes[0]).toMatchObject({ filesystem: "exfat", writable: false });
  });

  it("normalizes Windows CIM output", async () => {
    const runner: CommandRunner = { run: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({
      Number: 3, UniqueId: "USB-123", Name: "Portable", Size: 4_001_000_000_000, BusType: "USB", PartitionStyle: "GPT", IsBoot: false, IsSystem: false,
      Volumes: [{ Id: 1, Name: "AIARK", DriveLetter: "E", FileSystem: "exFAT", Size: 4_000_000_000_000, Free: 3_000_000_000_000, ReadOnly: false }],
    }) }) };
    const [detected] = await new DiskManager(runner, "win32").detectExternalDisks();
    expect(detected).toMatchObject({ id: "PhysicalDrive3", devicePath: "\\\\.\\PhysicalDrive3", systemDisk: false });
    expect(new DiskManager(runner, "win32").assess(detected!)).toMatchObject({ canPrepare: true });
  });
});

import { describe, expect, it } from "vitest";
import { parsePlist } from "../src/core/plist";

describe("parsePlist", () => {
  it("parses nested diskutil values and empty dictionaries", () => {
    const value = parsePlist(`<?xml version="1.0"?><plist version="1.0"><dict>
      <key>DeviceIdentifier</key><string>disk9</string>
      <key>Size</key><integer>4000000000000</integer>
      <key>Internal</key><false/>
      <key>Metadata</key><dict/>
      <key>Partitions</key><array><dict><key>Name</key><string>AIARK</string></dict></array>
    </dict></plist>`);
    expect(value).toEqual({
      DeviceIdentifier: "disk9",
      Size: 4_000_000_000_000,
      Internal: false,
      Metadata: {},
      Partitions: [{ Name: "AIARK" }],
    });
  });
});

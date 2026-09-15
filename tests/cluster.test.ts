import { describe, expect, it } from "vitest";
import { parsePeerAnnouncement } from "../src/core/cluster";

describe("cluster discovery packets", () => {
  it("accepts AiArk v1 announcements and ignores unrelated UDP data", () => {
    const peer = parsePeerAnnouncement(Buffer.from(JSON.stringify({
      protocol: "aiark-discovery-v1", id: "node-1", hostname: "ark-node", platform: "linux", arch: "x64", appVersion: "0.1.0", capabilities: ["model-storage"],
    })), "192.0.2.5");
    expect(peer).toMatchObject({ id: "node-1", address: "192.0.2.5", platform: "linux" });
    expect(parsePeerAnnouncement(Buffer.from("not json"), "192.0.2.6")).toBeNull();
  });
});

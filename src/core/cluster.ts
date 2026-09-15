import dgram from "node:dgram";
import os from "node:os";
import { createHash } from "node:crypto";
import { ClusterPeer, HardwareProfile, Platform } from "./types";

const MULTICAST_ADDRESS = "239.255.42.99";
const MULTICAST_PORT = 42499;
const PROTOCOL = "aiark-discovery-v1";

interface Announcement {
  protocol: typeof PROTOCOL;
  id: string;
  hostname: string;
  platform: Platform;
  arch: string;
  appVersion: string;
  capabilities: string[];
}

function nodeId(): string {
  return createHash("sha256").update(`${os.hostname()}:${os.arch()}:${os.platform()}`).digest("hex").slice(0, 16);
}

export function parsePeerAnnouncement(data: Buffer, address: string): ClusterPeer | null {
  try {
    const value = JSON.parse(data.toString("utf8")) as Partial<Announcement>;
    if (value.protocol !== PROTOCOL || !value.id || !value.hostname || !value.platform || !value.arch) return null;
    if (!["darwin", "linux", "win32"].includes(value.platform)) return null;
    return {
      id: value.id,
      hostname: String(value.hostname).slice(0, 255),
      platform: value.platform,
      arch: String(value.arch).slice(0, 40),
      appVersion: String(value.appVersion ?? "unknown").slice(0, 40),
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String).slice(0, 20) : [],
      address,
      lastSeen: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function discoverClusterPeers(
  hardware: HardwareProfile,
  timeoutMs = 1_500,
): Promise<ClusterPeer[]> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const peers = new Map<string, ClusterPeer>();
  const ownId = nodeId();
  const announcement: Announcement = {
    protocol: PROTOCOL,
    id: ownId,
    hostname: hardware.hostname,
    platform: hardware.platform,
    arch: hardware.arch,
    appVersion: "0.1.0",
    capabilities: ["catalog-v1", "model-storage"],
  };
  socket.on("message", (data, remote) => {
    const peer = parsePeerAnnouncement(data, remote.address);
    if (peer && peer.id !== ownId) peers.set(peer.id, peer);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(MULTICAST_PORT, () => {
        try {
          socket.addMembership(MULTICAST_ADDRESS);
          socket.setMulticastTTL(1);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const payload = Buffer.from(JSON.stringify(announcement));
    await new Promise<void>((resolve, reject) => socket.send(payload, MULTICAST_PORT, MULTICAST_ADDRESS, (error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Math.min(timeoutMs, 10_000))));
  } finally {
    try {
      socket.address();
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    } catch {
      // The socket never bound, so there is nothing left to close.
    }
  }
  return [...peers.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

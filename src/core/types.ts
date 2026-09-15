export type Platform = "darwin" | "linux" | "win32";

export type Accelerator = "metal" | "cuda" | "rocm" | "vulkan" | "directml" | "cpu";

export interface GpuInfo {
  name: string;
  vendor: "apple" | "nvidia" | "amd" | "intel" | "unknown";
  vramBytes: number | null;
  accelerator: Accelerator;
  unifiedMemory: boolean;
}

export interface HardwareProfile {
  platform: Platform;
  release: string;
  arch: string;
  hostname: string;
  cpuModel: string;
  cpuCores: number;
  ramBytes: number;
  gpus: GpuInfo[];
  detectedAt: string;
}

export interface DiskVolume {
  id: string;
  name: string;
  mountPoint: string | null;
  filesystem: string | null;
  writable: boolean;
  sizeBytes: number;
  freeBytes: number | null;
}

export interface ExternalDisk {
  id: string;
  devicePath: string;
  name: string;
  sizeBytes: number;
  bus: string | null;
  external: boolean;
  removable: boolean;
  partitionScheme: string | null;
  systemDisk: boolean;
  volumes: DiskVolume[];
  fingerprint: string;
}

export interface DiskAssessment {
  disk: ExternalDisk;
  eligibleSize: boolean;
  recommendedFormat: boolean;
  recommendedScheme: boolean;
  mountedWritableVolume: DiskVolume | null;
  canPrepare: boolean;
  warnings: string[];
  confirmation: string;
}

export interface ModelArtifact {
  url: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  chunkSizeBytes?: number;
  chunkSha256?: string[];
}

export interface ModelRequirements {
  minRamGb: number;
  recommendedRamGb: number;
  minVramGb?: number;
  accelerators?: Accelerator[];
  platforms?: Platform[];
  architectures?: string[];
}

export interface ModelManifestEntry {
  id: string;
  name: string;
  family: string;
  parameterCount: string;
  quantization: string;
  format: "gguf" | "onnx" | "safetensors";
  license: string;
  source: string;
  runtime: string;
  tags: string[];
  requirements: ModelRequirements;
  artifact: ModelArtifact;
}

export interface ModelCatalog {
  schemaVersion: number;
  generatedAt: string;
  models: ModelManifestEntry[];
}

export interface CompatibilityResult {
  model: ModelManifestEntry;
  status: "recommended" | "compatible" | "limited" | "incompatible";
  score: number;
  reasons: string[];
}

export interface DownloadProgress {
  artifactId: string;
  downloadedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
}

export interface RuntimeAssetRule {
  platform: Platform;
  arch: string;
  accelerator: Accelerator;
  pattern: string;
}

export interface RuntimeDefinition {
  id: string;
  name: string;
  releasesApi: string;
  executable: Record<Platform, string>;
  assets: RuntimeAssetRule[];
}

export interface RuntimeCatalog {
  schemaVersion: number;
  runtimes: RuntimeDefinition[];
}

export interface RuntimeInstallPlan {
  runtimeId: string;
  version: string;
  accelerator: Accelerator;
  downloadUrl: string;
  archiveName: string;
  sizeBytes: number;
  sha256: string | null;
  installDirectory: string;
}

export interface ClusterPeer {
  id: string;
  hostname: string;
  platform: Platform;
  arch: string;
  appVersion: string;
  capabilities: string[];
  address: string;
  lastSeen: string;
}

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import {
  DiskManager,
  HardwareDetector,
  ModelManager,
  RuntimeManager,
  buildCompatibilityMatrix,
  discoverClusterPeers,
  inspectPreparedArk,
  loadModelCatalog,
  loadRuntimeCatalog,
  prepareArk,
  previewPreparation,
} from "../core";

let mainWindow: BrowserWindow | null = null;

async function scan() {
  const diskManager = new DiskManager();
  const [hardware, catalog, disks] = await Promise.all([
    new HardwareDetector().detect(),
    loadModelCatalog(),
    diskManager.detectExternalDisks(),
  ]);
  const assessments = disks.map((disk) => diskManager.assess(disk));
  const prepared = await Promise.all(assessments.map((assessment) => inspectPreparedArk(assessment)));
  return {
    hardware,
    disks: assessments.map((assessment, index) => ({
      ...assessment,
      arkPrepared: prepared[index]?.prepared ?? false,
      arkRoot: prepared[index]?.root ?? null,
    })),
    compatibility: buildCompatibilityMatrix(catalog, hardware),
  };
}

async function assessmentFor(selector: string) {
  const manager = new DiskManager();
  const disks = await manager.detectExternalDisks();
  const disk = disks.find((item) => item.id === selector || item.fingerprint === selector);
  if (!disk) throw new Error("Selected external disk is no longer connected");
  return manager.assess(disk);
}

function registerIpc(): void {
  ipcMain.handle("aiark:scan", () => scan());
  ipcMain.handle("aiark:preview", async (_event, diskId: string) => previewPreparation(await assessmentFor(diskId)));
  ipcMain.handle("aiark:format-preview", async (_event, diskId: string) => {
    const manager = new DiskManager();
    const assessment = await assessmentFor(diskId);
    return manager.formatPreview(assessment.disk);
  });
  ipcMain.handle("aiark:prepare", async (_event, diskId: string, confirmation: string) => {
    const assessment = await assessmentFor(diskId);
    return prepareArk(assessment, confirmation, await loadModelCatalog());
  });
  ipcMain.handle("aiark:model-download", async (_event, modelId: string, diskId: string) => {
    const assessment = await assessmentFor(diskId);
    const mountPoint = assessment.mountedWritableVolume?.mountPoint;
    if (!mountPoint) throw new Error("Selected disk is not mounted writable storage");
    const manager = new ModelManager(await loadModelCatalog());
    return manager.download(modelId, path.join(mountPoint, "AIARK"), {
      onProgress: (progress) => mainWindow?.webContents.send("aiark:download-progress", progress),
    });
  });
  ipcMain.handle("aiark:model-verify", async (_event, modelId: string, diskId: string) => {
    const assessment = await assessmentFor(diskId);
    const mountPoint = assessment.mountedWritableVolume?.mountPoint;
    if (!mountPoint) throw new Error("Selected disk is not mounted writable storage");
    return new ModelManager(await loadModelCatalog()).verify(modelId, path.join(mountPoint, "AIARK"));
  });
  ipcMain.handle("aiark:runtime-plan", async (_event, runtimeId: string) => {
    const [hardware, catalog] = await Promise.all([new HardwareDetector().detect(), loadRuntimeCatalog()]);
    return new RuntimeManager(catalog).plan(runtimeId, hardware);
  });
  ipcMain.handle("aiark:runtime-install", async (_event, runtimeId: string) => {
    const [hardware, catalog] = await Promise.all([new HardwareDetector().detect(), loadRuntimeCatalog()]);
    const manager = new RuntimeManager(catalog);
    const plan = await manager.plan(runtimeId, hardware);
    return manager.install(plan, hardware, {
      onProgress: (progress) => mainWindow?.webContents.send("aiark:download-progress", progress),
    });
  });
  ipcMain.handle("aiark:cluster", async () => discoverClusterPeers(await new HardwareDetector().detect()));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#08100d",
    title: "AiArk",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  void mainWindow.loadFile(path.join(app.getAppPath(), "src", "renderer", "index.html")).catch((error) => {
    console.error("Unable to load AiArk renderer", error);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

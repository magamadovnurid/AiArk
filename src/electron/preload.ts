import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aiark", {
  scan: () => ipcRenderer.invoke("aiark:scan"),
  preview: (diskId: string) => ipcRenderer.invoke("aiark:preview", diskId),
  formatPreview: (diskId: string) => ipcRenderer.invoke("aiark:format-preview", diskId),
  prepare: (diskId: string, confirmation: string) => ipcRenderer.invoke("aiark:prepare", diskId, confirmation),
  downloadModel: (modelId: string, diskId: string) => ipcRenderer.invoke("aiark:model-download", modelId, diskId),
  verifyModel: (modelId: string, diskId: string) => ipcRenderer.invoke("aiark:model-verify", modelId, diskId),
  planRuntime: (runtimeId: string) => ipcRenderer.invoke("aiark:runtime-plan", runtimeId),
  installRuntime: (runtimeId: string) => ipcRenderer.invoke("aiark:runtime-install", runtimeId),
  discoverCluster: () => ipcRenderer.invoke("aiark:cluster"),
  onDownloadProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("aiark:download-progress", listener);
    return () => ipcRenderer.removeListener("aiark:download-progress", listener);
  },
});

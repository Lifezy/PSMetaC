const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("psbCleaner", {
  bootstrapStatus: () => ipcRenderer.invoke("bootstrap:status"),
  inspectBootstrap: (input) => ipcRenderer.invoke("bootstrap:inspect", input),
  initialize: (input) => ipcRenderer.invoke("bootstrap:initialize", input),
  invoke: (method, params = {}) =>
    ipcRenderer.invoke("service:invoke", { method, params }),
  chooseDirectory: (kind = "output") =>
    ipcRenderer.invoke("dialog:directory", kind),
  chooseFiles: () => ipcRenderer.invoke("dialog:files"),
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),
  addDroppedPaths: (paths) =>
    ipcRenderer.invoke("selection:add-dropped-paths", paths),
  removeSelectedFile: (selectedPath) =>
    ipcRenderer.invoke("selection:remove-file", selectedPath),
  removeSelectedFiles: (selectedPaths) =>
    ipcRenderer.invoke("selection:remove-files", selectedPaths),
  chooseSettingsImport: () => ipcRenderer.invoke("dialog:settings-import"),
  chooseSettingsExport: () => ipcRenderer.invoke("dialog:settings-export"),
  chooseDiagnosticExport: () =>
    ipcRenderer.invoke("dialog:diagnostic-export"),
  openPath: (target) => ipcRenderer.invoke("shell:open-path", target),
  revealExport: (target) => ipcRenderer.invoke("shell:reveal-export", target),
  openJobTarget: (jobId, kind) =>
    ipcRenderer.invoke("shell:open-job-target", { jobId, kind }),
  windowControl: (action) => ipcRenderer.invoke("window:control", action),
  onWindowState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("window-state", handler);
    return () => ipcRenderer.removeListener("window-state", handler);
  },
  onJobChanged: (listener) => {
    const handler = (_event, job) => listener(job);
    ipcRenderer.on("job-changed", handler);
    return () => ipcRenderer.removeListener("job-changed", handler);
  },
  onNavigate: (listener) => {
    const handler = (_event, view) => listener(view);
    ipcRenderer.on("navigate", handler);
    return () => ipcRenderer.removeListener("navigate", handler);
  },
});

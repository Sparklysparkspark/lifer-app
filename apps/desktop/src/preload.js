const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liferSetup", {
  choose: (config) => ipcRenderer.invoke("lifer:choose-setup", config),
  getConfig: () => ipcRenderer.invoke("lifer:get-config"),
});

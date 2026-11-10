// Floppy's page gets two calls and nothing else: hear what dx says, and say what was clicked.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floppy", {
  on: (fn) => ipcRenderer.on("floppy", (_e, msg) => fn(msg)),
  send: (ev) => ipcRenderer.send("floppy", ev),
});

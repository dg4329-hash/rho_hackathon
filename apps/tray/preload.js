// @ts-check
// Exposes window.meshResize(w, h) to the overlay page. Electron blocks window.resizeTo() on windows that
// were not opened by script, so the page (or the resizeTo shim main.js installs) calls this instead.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meshResize", (/** @type {number} */ w, /** @type {number} */ h) =>
  ipcRenderer.invoke("mesh:resize", { width: Number(w), height: Number(h) }));
contextBridge.exposeInMainWorld("meshTray", { platform: process.platform, version: process.versions.electron });

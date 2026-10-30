// Preload for the render sandbox window. Runs with sandbox: true, so only `electron`'s renderer
// modules are available. Exposes a two-function message bridge and nothing else: no file system,
// no app API, no secrets.
import { contextBridge, ipcRenderer } from 'electron';

const COMMAND = 'render-sandbox:command';
const MESSAGE = 'render-sandbox:message';

contextBridge.exposeInMainWorld('renderHost', {
  send: (message: unknown) => ipcRenderer.send(MESSAGE, message),
  onCommand: (callback: (command: unknown) => void) => {
    ipcRenderer.on(COMMAND, (_event, command) => callback(command));
  },
});

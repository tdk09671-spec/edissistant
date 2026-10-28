import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => callback(maximized);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => {
      ipcRenderer.removeListener('window:maximized-changed', listener);
    };
  },

  // Presets
  loadPresets: () => ipcRenderer.invoke('presets:load'),
  savePresets: (presets: unknown) => ipcRenderer.invoke('presets:save', presets),

  // Projects
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProjects: (projects: unknown) => ipcRenderer.invoke('projects:save', projects),

  // Settings
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),

  // Secure credentials (values are write-only from the renderer)
  getSecretStatus: () => ipcRenderer.invoke('secrets:status'),
  setSecret: (name: string, value: string) => ipcRenderer.invoke('secrets:set', name, value),
  deleteSecret: (name: string) => ipcRenderer.invoke('secrets:delete', name),

  // Files & dialogs
  openFiles: (options: unknown) => ipcRenderer.invoke('dialog:openFiles', options),
  openDirectory: (options: unknown) => ipcRenderer.invoke('dialog:openDirectory', options),
  readTextFile: (filePath: string) => ipcRenderer.invoke('file:readText', filePath),
  saveTextFile: (options: unknown) => ipcRenderer.invoke('file:saveText', options),
  fileExists: (filePath: string) => ipcRenderer.invoke('file:exists', filePath),
  openFolder: (folderPath: string) => ipcRenderer.invoke('shell:openFolder', folderPath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItem', filePath),

  // App
  getAppInfo: () => ipcRenderer.invoke('app:info'),
});

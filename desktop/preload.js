// 预加载：暴露安全 IPC 桥
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  toggleChat: (open, petRect) => ipcRenderer.invoke('toggle-chat', open, petRect),
  winMove: (dx, dy) => ipcRenderer.send('win-move', { dx, dy }),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  contextMenu: (payload) => ipcRenderer.send('context-menu', payload),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  qrDataUrl: (text) => ipcRenderer.invoke('qr-dataurl', text),
  onMenuSwitchProject: (cb) => ipcRenderer.on('menu-switch-project', (_e, id) => cb(id)),
  onMenuOpenSettings: (cb) => ipcRenderer.on('menu-open-settings', () => cb()),
  onMenuOpenTable: (cb) => ipcRenderer.on('menu-open-table', () => cb()),
})

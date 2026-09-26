/**
 * Мостик страницы к оболочке — ровно три функции для галки «Разрешить ИИ»
 * в «Настройках». Node странице не даём: только эти вызовы, по одному
 * каналу каждый.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('painterHost', {
  mcp: {
    state: () => ipcRenderer.invoke('mcp:state'),
    setEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', !!on),
    newKey: () => ipcRenderer.invoke('mcp:new-key'),
  },
});

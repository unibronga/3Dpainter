/**
 * Мостик страницы к оболочке: три функции для галки «Разрешить ИИ» в
 * «Настройках» и одна — соседние файлы модели (.mtl и его картинки). Node
 * странице не даём: только эти вызовы, по одному каналу каждый.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('painterHost', {
  mcp: {
    state: () => ipcRenderer.invoke('mcp:state'),
    setEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', !!on),
    newKey: () => ipcRenderer.invoke('mcp:new-key'),
  },
  model: {
    // Путь к файлу знает только оболочка; страница отдаёт сам File.
    companions: (file) => ipcRenderer.invoke('model:companions', webUtils.getPathForFile(file)),
  },
});

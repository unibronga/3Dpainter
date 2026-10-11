/**
 * Мостик страницы к оболочке: три функции для галки «Разрешить ИИ» в
 * «Настройках», соседние файлы модели (.mtl и его картинки) и задания
 * LevelMaker. Node странице не даём: только эти вызовы, по одному каналу
 * каждый. Файлы задания страница читает по номеру задания, не по пути.
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
  // Файлы, которыми открыли программу: задание LevelMaker или модель/проект.
  host: {
    ready: () => ipcRenderer.send('host:ready'),
    onOpenFile: (cb) => { ipcRenderer.on('host:open-file', (_e, f) => cb(f)); },
  },
  job: {
    onIncoming: (cb) => { ipcRenderer.on('job:incoming', (_e, j) => cb(j)); },
    read: (id, what) => ipcRenderer.invoke('job:read', id, what),
    status: (id, state, code, detail) => ipcRenderer.invoke('job:status', id, state, code, detail || ''),
    deliver: (id, payload) => ipcRenderer.invoke('job:return', id, payload),
  },
});

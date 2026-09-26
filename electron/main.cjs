/**
 * Оболочка для запуска инструмента на десктопе.
 *
 * Обычное окно Chromium без интеграции с Node: инструменту она не нужна,
 * а без неё страница остаётся ровно тем же, что открывается в браузере.
 */

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const { McpServer } = require('./mcp.cjs');

// Путь к собранной странице. В разработке можно подсунуть адрес Vite:
//   PAINT_TOOL_DEV_URL=http://localhost:5273 npm run desktop:dev
const DEV_URL = process.env.PAINT_TOOL_DEV_URL;
const INDEX = path.join(__dirname, '..', 'dist', 'index.html');

let win = null;

// Своя папка данных — для проверок: иначе тестовый запуск делит настройки
// (и ключ MCP) с установленной программой.
if (process.env.PAINT_TOOL_USER_DATA) app.setPath('userData', process.env.PAINT_TOOL_USER_DATA);

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 680,
    title: '3DPainter',
    // Цвет фона совпадает с темой: иначе при открытии мигает белым.
    backgroundColor: '#1b1d21',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Мостик на три вызова — только для галки «Разрешить ИИ» (MCP).
      preload: path.join(__dirname, 'preload.cjs'),
      // Своя папка для localStorage: настройки панелей не смешиваются с
      // тем, что инструмент запомнил в браузере.
      partition: 'persist:paint-tool',
    },
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(INDEX);

  // Диагностика запуска: молчаливо белое окно ни о чём не говорит.
  win.webContents.on('did-finish-load', async () => {
    console.log('[paint-tool] страница загружена');
    if (!process.env.PAINT_TOOL_SELFTEST) return;

    // Дымовая проверка сборки: одно дело — открыть файл, другое — убедиться,
    // что инструмент поднялся и модель собралась.
    try {
      const report = await win.webContents.executeJavaScript(`
        new Promise((resolve) => setTimeout(async () => {
          const P = window.__paint;
          // Мостик MCP: preload поднялся и оболочка отвечает (ключ не печатаем).
          const ии = window.painterHost
            ? await window.painterHost.mcp.state().then((s) => ({ включён: s.enabled, порт: s.port }), (e) => 'ошибка: ' + e.message)
            : 'нет мостика';
          resolve(JSON.stringify({
            ии,
            инструментыИИ: window.__mcp ? window.__mcp.list().length : 0,
            поднялся: !!P,
            мешей: P ? P.viewport.paintables.length : 0,
            инструментов: document.querySelectorAll('.tool').length,
            меню: document.querySelectorAll('.menu-title').length,
            // Значок начального экрана — картинка из сборки: в упакованном
            // приложении путь другой, и битой она станет молча.
            значок: (() => {
              const i = document.querySelector('.welcome-icon');
              return i ? (i.complete && i.naturalWidth > 0) : 'нет узла';
            })(),
            имя: document.querySelector('.welcome-name')?.textContent || '—',
            версия: document.querySelector('.welcome-version')?.textContent || '—',
            ошибки: P ? P.bootErrors : ['нет доступа к состоянию'],
          }));
        }, 2500));
      `);
      console.log('[paint-tool] самопроверка:', report);
    } catch (e) {
      console.error('[paint-tool] самопроверка не прошла:', e.message);
    }
    app.quit();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[paint-tool] страница не загрузилась:', code, desc, url);
  });

  // Внешние ссылки — в браузер, а не внутрь окна инструмента.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Системное меню держим минимальным: своё меню у инструмента на странице,
 * здесь нужны только то, без чего macOS-приложение неудобно, — выход,
 * правка буфера обмена и масштаб окна.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Вернуть' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Крупнее' },
        { role: 'zoomOut', label: 'Мельче' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { role: 'minimize', label: 'Свернуть' },
        { role: 'close', label: 'Закрыть' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * MCP: ИИ красит открытую модель. Выключен, пока человек не включит его в
 * «Настройках»; включённый поднимается вместе с программой.
 */
let mcp = null;

app.whenReady().then(async () => {
  buildMenu();
  mcp = new McpServer({
    file: path.join(app.getPath('userData'), 'mcp.json'),
    page: () => (win && !win.isDestroyed() ? win.webContents : null),
    version: app.getVersion(),
  });
  ipcMain.handle('mcp:state', () => mcp.state());
  ipcMain.handle('mcp:set-enabled', (_e, on) => mcp.setEnabled(on));
  ipcMain.handle('mcp:new-key', () => mcp.newKey());
  if (mcp.cfg.enabled && !process.env.PAINT_TOOL_SELFTEST) await mcp.start();
  createWindow();

  // На macOS щелчок по значку в доке открывает окно заново.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

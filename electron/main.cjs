/**
 * Оболочка для запуска инструмента на десктопе.
 *
 * Обычное окно Chromium без интеграции с Node: инструменту она не нужна,
 * а без неё страница остаётся ровно тем же, что открывается в браузере.
 */

const { app, BrowserWindow, Menu, shell, ipcMain, session, dialog } = require('electron');
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

/**
 * 🔴 Сохранение набором в папку и «закрытые» папки.
 *
 * Chromium не даёт странице писать в домашнюю папку, «Загрузки», «Рабочий
 * стол» и системные папки: Chrome при этом спрашивает человека, а Electron без
 * обработчика молча запрещает. Окно выбора просто закрывалось, страница
 * понимала это как «передумал» — и выгрузка лица в «Загрузки» не сохраняла
 * ничего, без единой ошибки.
 *
 * Папки пользователя и всё внутри них (кроме ~/Library) разрешаем: человек
 * выбрал их сам, а программа создаёт там только свою подпапку. Системные — нет:
 * объясняем и открываем выбор заново.
 */
const сессииСПапками = new WeakSet();
function разрешитьПапкиПользователя(сессия) {
  if (сессииСПапками.has(сессия)) return;     // окно на macOS создаётся заново — обработчик один
  сессииСПапками.add(сессия);
  const path = require('node:path');
  const дом = app.getPath('home');
  const библиотека = path.join(дом, 'Library');
  const свои = ['home', 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']
    .map((k) => { try { return app.getPath(k); } catch { return null; } }).filter(Boolean);
  const внутри = (p, корень) => p === корень || p.startsWith(корень + path.sep);
  сессия.on('file-system-access-restricted', async (e, d, callback) => {
    const p = path.resolve(d.path);
    if (!внутри(p, библиотека) && свои.some((корень) => внутри(p, корень))) { callback('allow'); return; }
    const ru = /^(ru|uk|be)/i.test(app.getLocale());
    await dialog.showMessageBox(BrowserWindow.fromWebContents(d.webContents) || undefined, {
      type: 'warning',
      message: ru ? 'В эту папку сохранять нельзя' : 'Cannot save to this folder',
      detail: ru ? `«${p}» — системная папка. Выберите папку в своей домашней: «Документы», «Загрузки», «Рабочий стол».`
        : `“${p}” is a system folder. Pick a folder in your home: Documents, Downloads, Desktop.`,
    });
    callback('tryAgain');
  });
}

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

  разрешитьПапкиПользователя(session.fromPartition('persist:paint-tool'));
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

/**
 * Соседи модели, на которые она сама ссылается по имени: .mtl из строки
 * `mtllib` у .obj и картинки из `map_*` в этой библиотеке.
 *
 * Страница видит только файл, который человек выбрал, а цвета .obj лежат в
 * соседнем .mtl — выбирать его вручную никто не догадывается, и модель,
 * покрашенная в 3DModelist, открывалась белой. Берём строго то, что названо
 * в файлах модели, только из её же папки (имя без пути), только .mtl и
 * картинки, не больше 64 МБ на файл.
 */
const COMPANION_EXT = new Set(['.mtl', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga']);
async function companionsOf(файл) {
  const fsp = require('node:fs/promises');
  if (typeof файл !== 'string' || path.extname(файл).toLowerCase() !== '.obj') return [];
  const папка = path.dirname(файл);
  const прочесть = async (имя) => {
    const чистое = path.basename(имя.trim().replace(/\\/g, '/'));
    if (!COMPANION_EXT.has(path.extname(чистое).toLowerCase())) return null;
    const полный = path.join(папка, чистое);
    try {
      const st = await fsp.stat(полный);
      if (!st.isFile() || st.size > 64 * 1024 * 1024) return null;
      return { name: чистое, data: new Uint8Array(await fsp.readFile(полный)) };
    } catch { return null; }
  };
  const найдено = new Map();
  const добавить = (f) => { if (f && !найдено.has(f.name.toLowerCase())) найдено.set(f.name.toLowerCase(), f); };
  let obj;
  try { obj = await fsp.readFile(файл, 'utf8'); } catch { return []; }
  // Имя библиотеки может разойтись с тем, что лежит в папке; тогда — .mtl с
  // именем модели, как его пишет Blender.
  const библиотеки = [...obj.matchAll(/^mtllib\s+(.+?)\s*$/gm)].map((x) => x[1]);
  библиотеки.push(path.basename(файл, path.extname(файл)) + '.mtl');
  for (const имя of библиотеки) {
    const mtl = await прочесть(имя);
    if (!mtl) continue;
    добавить(mtl);
    const текст = Buffer.from(mtl.data).toString('utf8');
    // Последнее слово строки — имя картинки, перед ним бывают ключи (-s 1 1 1).
    for (const [, хвост] of текст.matchAll(/^\s*(?:map_\w+|bump|disp|decal|refl)\s+(.+?)\s*$/gim)) {
      добавить(await прочесть(хвост.split(/\s+/).pop()));
    }
  }
  return [...найдено.values()];
}

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
  ipcMain.handle('model:companions', (_e, p) => companionsOf(p));
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

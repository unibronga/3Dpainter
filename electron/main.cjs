/**
 * Оболочка для запуска инструмента на десктопе.
 *
 * Обычное окно Chromium без интеграции с Node: инструменту она не нужна,
 * а без неё страница остаётся ровно тем же, что открывается в браузере.
 */

const { app, BrowserWindow, Menu, shell, ipcMain, session, dialog } = require('electron');
const path = require('node:path');
const { McpServer } = require('./mcp.cjs');
const lm = require('./levelmaker.cjs');

// Путь к собранной странице. В разработке можно подсунуть адрес Vite:
//   PAINT_TOOL_DEV_URL=http://localhost:5273 npm run desktop:dev
const DEV_URL = process.env.PAINT_TOOL_DEV_URL;
const INDEX = path.join(__dirname, '..', 'dist', 'index.html');

let win = null;

// Своя папка данных — для проверок: иначе тестовый запуск делит настройки
// (и ключ MCP) с установленной программой.
if (process.env.PAINT_TOOL_USER_DATA) app.setPath('userData', process.env.PAINT_TOOL_USER_DATA);

/* ── Файлы, которыми открывают программу ───────────────────────────
 *
 * Задание LevelMaker, проект или модель приходят тремя путями: событием
 * `open-file` (macOS, и холодный старт, и уже открытая программа), строкой
 * запуска (Windows и разработка) и от второго экземпляра (`second-instance`).
 * Пока страница не поднялась, файлы ждут в очереди.
 *
 * 🔴 `open-file` вешается до `ready`: при холодном старте macOS шлёт его
 * раньше, и без обработчика файл потерялся бы.
 */
const очередь = [];
let страницаГотова = false;

app.on('open-file', (e, файл) => {
  e.preventDefault();
  принятьФайл(файл);
});

/**
 * Второй копии быть не должно: Windows на каждый «Разукрасить» запускает
 * 3DPainter.exe заново, и задание должно прийти в уже открытое окно.
 * Для проверок (своя папка данных) замок тоже ставится — у каждой своя.
 * Разработка без своей папки живёт без замка, иначе `electron .` молча
 * уходил бы в установленную программу.
 */
const нуженЗамок = !process.env.PAINT_TOOL_SELFTEST && (app.isPackaged || !!process.env.PAINT_TOOL_USER_DATA);
if (нуженЗамок && !app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() })) {
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv, cwd, доп) => {
    // Свои argv и cwd второй экземпляр передаёт сам: на Windows строка
    // запуска первой копии может быть урезана.
    const a = Array.isArray(доп?.argv) ? доп.argv : argv;
    for (const f of lm.filesFromArgv(a.slice(1), доп?.cwd || cwd)) принятьФайл(f);
    вперёд();
  });
  for (const f of lm.filesFromArgv(process.argv.slice(1))) очередь.push(f);
}

/** Окно — вперёд: задание пришло, человек должен увидеть модель. */
function вперёд() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function принятьФайл(файл) {
  очередь.push(файл);
  if (app.isReady() && (!win || win.isDestroyed())) createWindow();
  разобратьОчередь();
}

/* Задания, которые знает оболочка. Страница видит их по номеру и читает
   только их файлы: задание называет пути, а произвольного чтения мы не даём. */
const задания = new Map();
let номерЗадания = 0;

async function разобратьОчередь() {
  if (!страницаГотова || !win || win.isDestroyed()) return;
  while (очередь.length) {
    const файл = очередь.shift();
    вперёд();
    if (!lm.isJobFile(файл)) {
      // Проект или модель — как при перетаскивании.
      try {
        const bytes = new Uint8Array(await require('node:fs/promises').readFile(файл));
        win.webContents.send('host:open-file', { name: path.basename(файл), bytes });
      } catch (e) { console.error('[paint-tool] не открыть', файл, e.message); }
      continue;
    }
    let job;
    try {
      job = lm.readJob(файл);
    } catch (e) {
      console.error('[paint-tool] задание LevelMaker:', e.message);
      if (e.job?.status) await lm.writeStatus(e.job, 'failed', { message: e.message, version: app.getVersion() }).catch(() => {});
      const ru = /^(ru|uk|be)/i.test(app.getLocale());
      dialog.showMessageBox(win, {
        type: 'warning',
        message: ru ? 'Задание LevelMaker не открыто' : 'LevelMaker job was not opened',
        detail: e.message,
      });
      continue;
    }
    job.id = ++номерЗадания;
    задания.set(job.id, job);
    // Странице — только то, что ей нужно показать и сравнить.
    win.webContents.send('job:incoming', {
      id: job.id, label: job.label, caller: job.caller,
      model: job.model, returnTo: job.return_to, hasProject: !!job.project,
    });
  }
}

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
  страницаГотова = false;
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
      // Мостик: галка «Разрешить ИИ» (MCP), соседи .obj, задания LevelMaker.
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
  win.webContents.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) страницаГотова = false; });
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

  /*
   * Сохранение из приложения: окна выбора и запись — здесь, у оболочки.
   *
   * Окно File System Access пути странице не отдаёт, а без пути итог
   * сохранения нельзя показать в Finder. Поэтому в приложении место выбирает
   * человек системным окном, страница получает его номер (не путь) и пишет
   * по номеру. Писать можно только туда, что выбрал сам человек.
   */
  const места = new Map();          // номер → { path, kind: 'folder'|'file'|'written' }
  let номерМеста = 0;
  const местоПоНомеру = (id, kind) => {
    const м = места.get(id);
    if (!м || (kind && м.kind !== kind)) throw new Error('место сохранения забыто — выберите заново');
    return м;
  };
  const запомнить = (p, kind) => { const id = ++номерМеста; места.set(id, { path: p, kind }); return id; };
  // Последняя папка — чтобы окно открывалось там же, где сохраняли в прошлый раз.
  const файлПапок = path.join(app.getPath('userData'), 'save-places.json');
  const последние = (() => { try { return JSON.parse(require('node:fs').readFileSync(файлПапок, 'utf8')); } catch { return {}; } })();
  const запомнитьПапку = (ключ, папка) => {
    последние[ключ] = папка;
    require('node:fs/promises').writeFile(файлПапок, JSON.stringify(последние)).catch(() => {});
  };
  const чистоеИмя = (имя) => String(имя).replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim() || 'model';
  // Для проверок: системное окно скриптом не нажать — место «выбирается» само,
  // а «Показать в Finder» отвечает путём, не открывая окон.
  const ТЕСТ = process.env.PAINT_TOOL_TEST_PICK || '';
  const вернутьИтог = (p, kind) => ({ id: запомнить(p, 'written'), name: path.basename(p), parent: path.basename(path.dirname(p)), kind });

  ipcMain.handle('files:pick-folder', async (e) => {
    if (ТЕСТ) return { id: запомнить(ТЕСТ, 'folder'), name: path.basename(ТЕСТ) };
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: последние.folder || app.getPath('documents'),
    });
    if (r.canceled || !r.filePaths[0]) return null;
    запомнитьПапку('folder', r.filePaths[0]);
    return { id: запомнить(r.filePaths[0], 'folder'), name: path.basename(r.filePaths[0]) };
  });
  ipcMain.handle('files:write-folder', async (_e, id, имяПапки, файлы) => {
    const fsp = require('node:fs/promises');
    const { path: корень } = местоПоНомеру(id, 'folder');
    // Папка с таким именем уже есть — «имя 2», «имя 3»: чужое не перезаписываем.
    const основа = чистоеИмя(имяПапки);
    let папка = path.join(корень, основа);
    for (let n = 2; await fsp.stat(папка).then(() => true, () => false); n++) папка = path.join(корень, `${основа} ${n}`);
    await fsp.mkdir(папка, { recursive: true });
    for (const { name, bytes } of файлы) await lm.writeAtomic(path.join(папка, чистоеИмя(name)), bytes);
    return { ...вернутьИтог(папка, 'folder'), count: файлы.length };
  });
  ipcMain.handle('files:pick-file', async (e, имя, тип) => {
    const ext = path.extname(String(имя)).slice(1);
    if (ТЕСТ) return { id: запомнить(path.join(ТЕСТ, чистоеИмя(имя)), 'file'), name: чистоеИмя(имя) };
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      defaultPath: path.join(последние.file || app.getPath('documents'), чистоеИмя(имя)),
      filters: ext ? [{ name: тип || ext.toUpperCase(), extensions: [ext] }] : [],
    });
    if (r.canceled || !r.filePath) return null;
    запомнитьПапку('file', path.dirname(r.filePath));
    return { id: запомнить(r.filePath, 'file'), name: path.basename(r.filePath) };
  });
  ipcMain.handle('files:write-file', async (_e, id, bytes) => {
    const { path: файл } = местоПоНомеру(id, 'file');
    await lm.writeAtomic(файл, bytes);
    return { ...вернутьИтог(файл, 'file'), count: 1 };
  });
  ipcMain.handle('files:reveal', async (_e, id) => {
    const { path: p } = местоПоНомеру(id, 'written');
    // Папку — открыть (видно, что внутри), файл — показать выделенным.
    const st = await require('node:fs/promises').stat(p).catch(() => null);
    if (!st) throw new Error('файла уже нет');
    if (ТЕСТ) return p;
    if (st.isDirectory()) { const err = await shell.openPath(p); if (err) throw new Error(err); }
    else shell.showItemInFolder(p);
    return true;
  });

  // Покраска из LevelMaker (`levelmaker.cjs`).
  ipcMain.on('host:ready', (e) => {
    if (!win || e.sender !== win.webContents) return;
    страницаГотова = true;
    разобратьОчередь();
  });
  ipcMain.handle('job:read', async (_e, id, что) => {
    const job = задания.get(id);
    const файл = job && (что === 'model' ? job.model : что === 'project' ? job.project : null);
    if (!файл) return null;
    try {
      return { name: path.basename(файл), bytes: new Uint8Array(await require('node:fs/promises').readFile(файл)) };
    } catch (e) {
      if (что === 'project' && e.code === 'ENOENT') return null;     // проекта ещё нет — это нормально
      throw new Error(`${файл}: ${e.code === 'ENOENT' ? 'файла нет' : e.message}`);
    }
  });
  ipcMain.handle('job:status', async (_e, id, state, код, подробно) => {
    const job = задания.get(id);
    if (!job || !['opened', 'cancelled', 'failed'].includes(state)) return false;
    const message = [lm.ПРИЧИНЫ[код] || '', подробно || ''].filter(Boolean).join(': ');
    await lm.writeStatus(job, state, { message, version: app.getVersion() });
    if (state !== 'opened') задания.delete(id);
    return true;
  });
  ipcMain.handle('job:return', async (_e, id, что) => {
    const job = задания.get(id);
    if (!job) throw new Error('задание уже закрыто');
    try {
      await lm.deliver(job, что);
    } catch (e) {
      await lm.writeStatus(job, 'failed', { message: `${lm.ПРИЧИНЫ['save-failed']}: ${e.message}`, version: app.getVersion() }).catch(() => {});
      throw e;
    }
    const st = await lm.writeStatus(job, 'saved', { version: app.getVersion() });
    // Вернуть человека в LevelMaker: на Mac — его же приложением; на Windows
    // окно сворачивается, LevelMaker выйдет вперёд сам, увидев `saved`.
    if (process.platform === 'darwin') {
      if (job.return_app) require('node:child_process').execFile('open', ['-a', job.return_app], (err) => {
        if (err) console.error('[paint-tool] не вернуть в', job.return_app, err.message);
      });
    } else if (win && !win.isDestroyed()) {
      win.minimize();
    }
    return { time: st.time };
  });
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

/**
 * Общая обвязка проверок: собранная страница в скрытом окне Electron,
 * строки «ok / FAIL», файлы туда-обратно через base64, сверка в Blender.
 *
 *   require('./harness.cjs').run('Название', async (h) => { … });
 *
 * Страница — `dist/index.html`, та же, что в приложении (`npm test` сперва
 * собирает её). Своя папка данных: проверка не трогает настройки установленной
 * программы.
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'dist', 'index.html');
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3dpainter-test-'));
app.setPath('userData', path.join(tmp, 'user'));

const провалы = [];

function check(условие, что) {
  console.log(`${условие ? '  ok ' : '  FAIL'} ${что}`);
  if (!условие) провалы.push(что);
}

/** Сверка в Blender, если он установлен: строки «ok / FAIL» из blender-check.py. */
function blender(файл, доп = []) {
  if (!fs.existsSync(BLENDER)) {
    console.log('  Blender не найден — проверка в нём пропущена (путь задаётся BLENDER=...)');
    return;
  }
  const r = spawnSync(BLENDER, ['-b', '--factory-startup', '-P', path.join(__dirname, 'blender-check.py'), '--', файл, ...доп],
    { encoding: 'utf8', timeout: 120000 });
  const строки = (r.stdout || '').split('\n').filter((s) => s.startsWith('  ok ') || s.startsWith('  FAIL'));
  console.log('  Blender:');
  строки.forEach((s) => console.log('  ' + s));
  строки.filter((s) => s.startsWith('  FAIL')).forEach((s) => провалы.push('Blender: ' + s.slice(7)));
  if (r.status !== 0 || !строки.length) провалы.push(`Blender завершился с кодом ${r.status}: ${(r.stderr || '').slice(-400)}`);
}

/** Код страницы: Blob или Uint8Array → base64 (чтобы вынести байты наружу). */
const В_BASE64 = `async (x) => {
  const b = x instanceof Uint8Array ? x : new Uint8Array(await x.arrayBuffer());
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}`;

function run(название, тело) {
  app.whenReady().then(async () => {
    if (!fs.existsSync(INDEX)) throw new Error('нет dist/index.html — сначала npm run build');
    const win = new BrowserWindow({
      show: false, width: 1400, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    await win.loadFile(INDEX);
    const js = (код) => win.webContents.executeJavaScript(код);
    await js(`new Promise((r) => { const ждать = () => window.__paint ? r() : setTimeout(ждать, 50); ждать(); })`);
    await js(`window.__b64 = ${В_BASE64}; 0`);     // функцию наружу не передать — возвращаем число
    console.log(`\n${название}:`);
    const ошибки = await js('window.__paint.bootErrors');
    check(!ошибки.length, `программа поднялась без ошибок ${ошибки.length ? JSON.stringify(ошибки) : ''}`);

    /** Открыть файл из base64 тем же путём, что и человек. */
    const open = (b64, имя) => js(`(async () => {
      const b = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0)).buffer;
      return window.__paint.openBuffer(b, '${имя}');
    })()`);
    /** Записать base64 во временную папку проверки, вернуть путь. */
    const save = (b64, имя) => { const f = path.join(tmp, имя); fs.writeFileSync(f, Buffer.from(b64, 'base64')); return f; };
    const fixture = (имя) => fs.readFileSync(path.join(__dirname, 'fixtures', имя)).toString('base64');

    await тело({ js, check, open, save, fixture, blender, tmp });
  }).then(
    () => {
      console.log(провалы.length ? `\nПРОВАЛ: ${провалы.length}` : '\nВсё на месте.');
      app.exit(провалы.length ? 1 : 0);
    },
    (e) => { console.error('Ошибка проверки:', e); app.exit(2); },
  );
}

module.exports = { run, check };

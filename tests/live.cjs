/**
 * Живая программа для проверок: настоящая оболочка (`electron .`) со своей
 * папкой данных и отладочным портом, страница — через CDP.
 *
 *   const live = require('./live.cjs')({ tmp, env: { ... } });
 *   const app = live.запустить([файлы]); const c = await live.cdp(); await c.js('…');
 *
 * Так проверяется то, чего не видит скрытое окно `harness.cjs`: оболочка,
 * её окна выбора, второй экземпляр, файлы на диске.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const ELECTRON = require('electron');

const ROOT = path.join(__dirname, '..');
const пауза = (мс) => new Promise((r) => setTimeout(r, мс));

module.exports = function live({ tmp, env = {} }) {
  const порт = 9400 + Math.floor(Math.random() * 400);

  function запустить(аргументы = []) {
    const p = spawn(ELECTRON, [ROOT, ...аргументы, `--remote-debugging-port=${порт}`], {
      env: { ...process.env, PAINT_TOOL_USER_DATA: path.join(tmp, 'user'), ELECTRON_RUN_AS_NODE: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.лог = '';
    p.stdout.on('data', (d) => { p.лог += d; });
    p.stderr.on('data', (d) => { p.лог += d; });
    p.вышел = new Promise((r) => p.on('exit', (код) => r(код)));
    return p;
  }

  async function страница() {
    for (let i = 0; i < 100; i++) {
      try {
        const список = await (await fetch(`http://127.0.0.1:${порт}/json/list`)).json();
        const p = список.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (p) return p.webSocketDebuggerUrl;
      } catch { /* ещё не поднялась */ }
      await пауза(150);
    }
    throw new Error('страница не поднялась');
  }

  async function cdp() {
    const ws = new WebSocket(await страница());
    await new Promise((ok, нет) => { ws.onopen = ok; ws.onerror = нет; });
    let n = 0;
    const ждут = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && ждут.has(d.id)) { ждут.get(d.id)(d); ждут.delete(d.id); }
    };
    const call = (method, params = {}) => new Promise((r) => { const id = ++n; ждут.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const js = async (код) => {
      const d = await call('Runtime.evaluate', { expression: код, awaitPromise: true, returnByValue: true });
      if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || 'ошибка в странице');
      return d.result?.result?.value;
    };
    // Ждём, пока программа поднимется.
    for (let i = 0; i < 100 && !(await js('!!window.__paint').catch(() => false)); i++) await пауза(100);
    /** Снимок окна (PNG, Buffer) — посмотреть глазами. */
    const снимок = async () => Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).result.data, 'base64');
    return { js, call, снимок, close: () => ws.close() };
  }

  return { запустить, cdp, пауза };
};

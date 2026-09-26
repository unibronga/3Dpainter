/**
 * MCP-сервер: ИИ (Claude и другие клиенты MCP) красит открытую модель.
 *
 * Только транспорт. Сами инструменты живут на странице (`src/mcp.js`), а
 * здесь — приём запросов и вызов `window.__mcp` через executeJavaScript:
 * страница остаётся без Node, как и была.
 *
 * Протокол — MCP поверх HTTP («Streamable HTTP») в самом простом виде: без
 * сессий и без потока событий. POST с JSON-RPC — ответ JSON. Этого хватает:
 * инструменты отвечают разом, уведомлений сервер не шлёт.
 *
 * 🔴 Безопасность. Локальный порт — дверь для любой программы на машине:
 *   - слушаем только 127.0.0.1, в сеть сервер не виден;
 *   - по умолчанию выключен — включает человек галкой в «Настройках»;
 *   - без ключа (Authorization: Bearer …) не отвечаем ничего;
 *   - запрос с заголовком Origin отклоняем: так приходят страницы из
 *     браузера, а клиенту MCP он не нужен. Это закрывает подмену DNS и
 *     попытки чужого сайта постучаться на localhost.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PORT = 5290;
/** Больше тела запроса не читаем: инструментам хватает килобайт. */
const MAX_BODY = 1 << 20;

const INSTRUCTIONS =
  '3DPainter is a tool for hand-painting low-poly 3D models. Start with describe_model and a ' +
  'render_view, then paint on your own layer (new_layer). The model is usually built from ' +
  'separate pieces (a boot, a sleeve, a wristband, a belt loop, the rim and center of a gem): ' +
  'name them from describe_model.pieces and paint whole parts with fill {target:{pieces:[...]}} ' +
  'first — it follows each part\'s own border. Use height/box fills only to split a piece that ' +
  'holds several colors, and fill_at on render_view pixels (same view/width/height; grid:true) ' +
  'for small details. Check with render_view from several sides (flat:true to compare colors) ' +
  'and fix mistakes with undo, not by painting over them. Finally call find_patches: fix only ' +
  'leftovers (paintedBy "broad" or "none"); patches with paintedBy "detail" are details you ' +
  'painted on purpose (holes, eyes, gem parts) — keep them.';

class McpServer {
  /**
   * @param {object} o
   * @param {string} o.file где хранить настройки (включён, порт, ключ)
   * @param {() => Electron.WebContents|null} o.page страница инструмента
   * @param {string} o.version версия программы
   */
  constructor({ file, page, version }) {
    this.file = file;
    this.page = page;
    this.version = version;
    this.server = null;
    this.error = null;
    this.cfg = this._load();
  }

  _load() {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* первый запуск */ }
    if (typeof cfg.token !== 'string' || cfg.token.length < 32) cfg.token = crypto.randomBytes(24).toString('hex');
    if (!Number.isInteger(cfg.port)) cfg.port = DEFAULT_PORT;
    cfg.enabled = cfg.enabled === true;
    return cfg;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Ключ — секрет: файл читает только владелец.
      fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 1), { mode: 0o600 });
    } catch (e) {
      console.error('[paint-tool] mcp: не сохранил настройки:', e.message);
    }
  }

  /** Что показать в «Настройках». */
  state() {
    return {
      enabled: this.cfg.enabled,
      running: !!this.server,
      port: this.cfg.port,
      url: `http://127.0.0.1:${this.cfg.port}/mcp`,
      token: this.cfg.token,
      error: this.error,
    };
  }

  async setEnabled(on) {
    this.cfg.enabled = !!on;
    this._save();
    if (on) await this.start(); else await this.stop();
    return this.state();
  }

  async newKey() {
    this.cfg.token = crypto.randomBytes(24).toString('hex');
    this._save();
    return this.state();
  }

  start() {
    if (this.server) return Promise.resolve();
    this.error = null;
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => this._handle(req, res));
      srv.on('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `port ${this.cfg.port} is busy` : e.message;
        console.error('[paint-tool] mcp:', this.error);
        this.server = null;
        resolve();
      });
      srv.listen(this.cfg.port, '127.0.0.1', () => {
        this.server = srv;
        console.log(`[paint-tool] mcp: слушаю http://127.0.0.1:${this.cfg.port}/mcp`);
        resolve();
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const srv = this.server;
    this.server = null;
    return new Promise((resolve) => srv.close(() => resolve()));
  }

  /* ── HTTP ────────────────────────────────────────────────────── */

  _authorized(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    const a = Buffer.from(m[1].trim());
    const b = Buffer.from(this.cfg.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _handle(req, res) {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (req.headers.origin) return send(403, { error: 'Browser requests are not accepted.' });
    const url = (req.url || '').split('?')[0];
    if (url !== '/mcp') return send(404, { error: 'Not found. The endpoint is /mcp.' });
    if (!this._authorized(req)) return send(401, { error: 'Missing or wrong key.' }, { 'WWW-Authenticate': 'Bearer' });
    // Потока событий нет: сервер ничего не шлёт сам.
    if (req.method === 'GET' || req.method === 'DELETE') return send(405, undefined, { Allow: 'POST' });
    if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(413, { error: 'Request too large.' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      const out = [];
      for (const m of batch) {
        const r = await this._rpc(m);
        if (r) out.push(r);
      }
      // Одни уведомления — ответа нет, только «принято».
      if (!out.length) return send(202);
      send(200, Array.isArray(msg) ? out : out[0]);
    });
  }

  /* ── JSON-RPC ────────────────────────────────────────────────── */

  async _rpc(m) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    const isNote = m.id === undefined || m.id === null;
    const ok = (result) => (isNote ? null : { jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => (isNote ? null : { jsonrpc: '2.0', id: m.id, error: { code, message } });

    try {
      switch (m.method) {
        case 'initialize': {
          const asked = m.params?.protocolVersion;
          return ok({
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: '3dpainter', title: '3DPainter', version: this.version },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: await this._page('list') });
        case 'tools/call': {
          const name = m.params?.name;
          const args = m.params?.arguments || {};
          if (typeof name !== 'string') return fail(-32602, 'Tool name is required.');
          const r = await this._page('call', name, args);
          if (r && r.__file) return ok(this._writeProject(r.__file));
          return ok(r);
        }
        default:
          if (m.method.startsWith('notifications/')) return null;
          return fail(-32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      return fail(-32603, e.message);
    }
  }

  /** Позвать страницу. Аргументы — только через JSON: в текст скрипта не попадает ничего сырого. */
  async _page(fn, ...args) {
    const wc = this.page();
    if (!wc || wc.isDestroyed()) throw new Error('3DPainter window is closed.');
    const js = `(window.__mcp ? window.__mcp.${fn === 'list' ? 'list' : 'call'}(...${JSON.stringify(args)})`
      + ` : Promise.reject(new Error('3DPainter is still starting.')))`;
    return wc.executeJavaScript(js);
  }

  /** Файл проекта пишет оболочка: у страницы доступа к диску нет. */
  _writeProject({ base64, path: p }) {
    const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
    if (typeof p !== 'string' || !path.isAbsolute(p)) return err('path must be an absolute path.');
    if (!/\.3dpaint$/i.test(p)) return err('path must end with .3dpaint.');
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) return err(`Folder does not exist: ${dir}`);
    try {
      const buf = Buffer.from(base64, 'base64');
      fs.writeFileSync(p, buf);
      return { content: [{ type: 'text', text: JSON.stringify({ saved: p, bytes: buf.length }) }] };
    } catch (e) {
      return err(`Could not write the file: ${e.message}`);
    }
  }
}

module.exports = { McpServer };

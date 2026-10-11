/**
 * Покраска из LevelMaker: договор `levelmaker-paint/1` живьём.
 *
 *   node tests/levelmaker-roundtrip.cjs     (npm test зовёт сам, после сборки)
 *
 * Поднимается настоящая оболочка (`electron .`) со своей папкой данных и
 * отладочным портом, задание приходит строкой запуска — как на Windows, и от
 * второго экземпляра — как при повторном «Разукрасить». Кнопки жмутся в
 * странице через CDP, файлы и состояния читаются с диска.
 *
 * Пути — с кириллицей, пробелами и скобками: такие и пишет LevelMaker.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lm = require('../electron/levelmaker.cjs');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3dpainter-lm-'));
const папка = path.join(tmp, 'Документы', 'LevelMaker', 'Покраска (тест)');
fs.mkdirSync(папка, { recursive: true });

const провалы = [];
function check(условие, что) {
  console.log(`${условие ? '  ok ' : '  FAIL'} ${что}`);
  if (!условие) провалы.push(что);
}
const пауза = (мс) => new Promise((r) => setTimeout(r, мс));

/* ── GLB: вершины, треугольники, габарит в мире ── */

function читатьGLB(файл) {
  const b = fs.readFileSync(файл);
  if (b.toString('ascii', 0, 4) !== 'glTF') return null;
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + len));
  return json;
}
function матрица(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const умножить = (a, b) => {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return r;
};
function сводкаGLB(файл) {
  const g = читатьGLB(файл);
  if (!g) return null;
  let вершин = 0, треугольников = 0, мешей = 0;
  const мин = [Infinity, Infinity, Infinity], макс = [-Infinity, -Infinity, -Infinity];
  const обойти = (i, родитель) => {
    const n = g.nodes[i];
    const m = умножить(родитель, матрица(n));
    if (n.mesh != null) {
      for (const p of g.meshes[n.mesh].primitives) {
        const a = g.accessors[p.attributes.POSITION];
        мешей++;
        вершин += a.count;
        треугольников += (p.indices != null ? g.accessors[p.indices].count : a.count) / 3;
        for (let c = 0; c < 8; c++) {
          const v = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
          for (let k = 0; k < 3; k++) {
            const w = m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k];
            мин[k] = Math.min(мин[k], w); макс[k] = Math.max(макс[k], w);
          }
        }
      }
    }
    for (const c of n.children || []) обойти(c, m);
  };
  const сцена = g.scenes[g.scene ?? 0];
  for (const i of сцена.nodes) обойти(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { мешей, вершин, треугольников, размер: макс.map((v, k) => v - мин[k]), центр: макс.map((v, k) => (v + мин[k]) / 2) };
}

/* ── Программа и CDP ── */

const { запустить, cdp } = require('./live.cjs')({ tmp });

/** Дождаться состояния `st` в файле состояния (новее `после`). */
async function ждатьСостояние(job, st, после = '', мс = 20000) {
  const t0 = Date.now();
  let последнее = null;
  while (Date.now() - t0 < мс) {
    try {
      последнее = JSON.parse(fs.readFileSync(job.status, 'utf8'));
      if (последнее.state === st && последнее.time !== после) return последнее;
    } catch { /* ещё нет */ }
    await пауза(100);
  }
  return последнее;
}
const времяСостояния = (job) => { try { return JSON.parse(fs.readFileSync(job.status, 'utf8')).time; } catch { return ''; } };

function задание(имя, поля = {}) {
  const j = {
    format: 'levelmaker-paint/1',
    caller: 'LevelMaker',
    label: имя,
    model: path.join(папка, `${имя}.glb`),
    project: path.join(папка, `${имя}.3dpaint`),
    return_to: path.join(папка, 'Готово', `${имя}.glb`),
    status: path.join(папка, `${имя}.status.json`),
    будущееПоле: 'пропускается',
    ...поля,
  };
  for (const k of Object.keys(j)) if (j[k] === undefined) delete j[k];
  const файл = path.join(папка, `${имя}.levelmaker.json`);
  fs.writeFileSync(файл, JSON.stringify(j, null, 2));
  return { ...j, файл };
}

const клик = (sel) => `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.offsetParent === null) return false; b.click(); return true; })()`;

/* ── Проверка ── */

(async () => {
  console.log('\nПокраска из LevelMaker:');

  // Разбор задания и строки запуска — без окна.
  {
    const ок = задание('Разбор (1)');
    const j = lm.readJob(ок.файл);
    check(j.label === 'Разбор (1)' && j.return_to === ок.return_to && j.project === ок.project, 'задание читается, неизвестные поля пропущены');
    const плохое = задание('Разбор (2)', { format: 'levelmaker-paint/2' });
    let ош = null; try { lm.readJob(плохое.файл); } catch (e) { ош = e; }
    check(ош?.job?.status === плохое.status && /версия/.test(ош.message), 'чужая версия договора — ошибка с путём состояния');
    const чужойПуть = задание('Разбор (3)', { return_to: path.join(папка, 'Готово', 'важное.txt') });
    ош = null; try { lm.readJob(чужойПуть.файл); } catch (e) { ош = e; }
    check(!!ош && /\.glb/.test(ош.message), 'задание не может писать не в .glb');
    const argv = ['--inspect', '-psn_0_123', path.relative(tmp, ок.файл), 'нет-такого.glb', ок.файл, '--remote-debugging-port=1'];
    const найдено = lm.filesFromArgv(argv, tmp);
    check(найдено.length === 2 && найдено.every((f) => f === ок.файл), 'строка запуска: ключи пропущены, относительный путь — от папки запуска');
    check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(lm.localIso()), 'время с часовым поясом');
  }

  const исходник = path.join(ROOT, 'public', 'test-props.glb');
  fs.copyFileSync(исходник, path.join(папка, 'Длинный камень.glb'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'leaf-rig.glb'), path.join(папка, 'Лист.glb'));
  const камень = задание('Длинный камень');
  const лист = задание('Лист', { project: undefined });
  const чужой = задание('Чужой', { format: 'levelmaker-paint/9' });

  // 1. Холодный старт: задание строкой запуска.
  let app = запустить([камень.файл]);
  let s = await ждатьСостояние(камень, 'opened');
  check(s?.state === 'opened' && s.format === 'levelmaker-paint/1' && s.painter_version, `холодный старт: состояние opened (${s?.state})`);
  let c = await cdp();
  check((await c.js('window.__paint.welcome.isOpen()')) === false, 'стартового экрана нет');
  check(await c.js('!document.getElementById("lm-bar").hidden'), 'полоса «Из LevelMaker» видна');
  check((await c.js('document.querySelector("#lm-bar .lm-label").textContent')) === 'Длинный камень', 'в полосе — имя из задания');

  // Метка покраски: красный слой — по нему узнаем проект при втором открытии.
  await c.js(`(() => { const P = window.__paint; for (const [, tg] of P.targets) { const L = tg.layers[tg.activeIndex];
    for (let i = 0; i < L.rgba.length; i += 4) { L.rgba[i] = 230; L.rgba[i+1] = 20; L.rgba[i+2] = 30; L.rgba[i+3] = 255; } tg.compositeRect(null); }
    P.state.painted = P.state.unsaved = true; return true; })()`);

  // 2. Сохранить и вернуть.
  check(await c.js(клик('#lm-return')), 'кнопка «Сохранить и вернуть» нажата');
  s = await ждатьСостояние(камень, 'saved', s?.time);
  check(s?.state === 'saved' && s.file === камень.return_to, `состояние saved с путём результата (${s?.state} ${s?.message || ''})`);
  const было = сводкаGLB(исходник), стало = fs.existsSync(камень.return_to) ? сводкаGLB(камень.return_to) : null;
  check(!!стало, 'return_to — GLB');
  if (стало) {
    check(стало.треугольников === было.треугольников, `треугольников столько же (${было.треугольников} → ${стало.треугольников})`);
    check(стало.вершин === было.вершин, `вершин столько же (${было.вершин} → ${стало.вершин})`);
    const отклонение = Math.max(...было.размер.map((v, k) => Math.abs(стало.размер[k] - v) / Math.max(v, 1e-6)));
    const сдвиг = Math.max(...было.центр.map((v, k) => Math.abs(стало.центр[k] - v)));
    check(отклонение < 0.001 && сдвиг < 1e-4, `габарит и положение те же (размер ±${(отклонение * 100).toFixed(3)}%, центр ±${сдвиг.toExponential(1)})`);
  }
  check(fs.existsSync(камень.project), 'проект сохранён по пути из задания');
  check(!fs.readdirSync(папка).concat(fs.readdirSync(path.dirname(камень.return_to))).some((f) => f.endsWith('.part')), 'недописанных .part не осталось');
  check(/\d/.test(await c.js('document.querySelector("#lm-bar .lm-sent").textContent')), 'полоса пишет время отправки');
  check((await c.js('window.__paint.state.unsaved')) === false, 'после отправки работа считается сохранённой');

  // Повторное нажатие — новое saved.
  await пауза(1100);
  await c.js(клик('#lm-return'));
  const s2 = await ждатьСостояние(камень, 'saved', s?.time);
  check(s2?.state === 'saved' && s2.time !== s?.time, 'повторная отправка — новое saved с новым временем');

  // 3. Второй экземпляр с незнакомой версией — уходит в первый, тот пишет failed.
  const второй = запустить([чужой.файл]);
  const кодВторого = await Promise.race([второй.вышел, пауза(15000).then(() => 'висит')]);
  check(кодВторого === 0, `второй экземпляр отдал задание и вышел (${кодВторого})`);
  s = await ждатьСостояние(чужой, 'failed');
  check(s?.state === 'failed' && /версия/.test(s.message), `чужая версия → failed с причиной: «${s?.message}»`);

  // 4. Другое задание при несохранённой работе: вопрос, «Отмена» → cancelled.
  await c.js('window.__paint.state.unsaved = true');
  запустить([лист.файл]);
  let вопрос = false;
  for (let i = 0; i < 80 && !вопрос; i++) { await пауза(100); вопрос = await c.js('!!document.querySelector(".modal-back.open .ask-text")'); }
  check(вопрос, 'несохранённая работа — вопрос «Сохранить / Не сохранять / Отмена»');
  await c.js(`(() => { const b = [...document.querySelectorAll('.modal-back.open .btn')].find((x) => x.dataset.i18n === 'ask.cancel'); b.click(); return 1; })()`);
  s = await ждатьСостояние(лист, 'cancelled');
  check(s?.state === 'cancelled', `«Отмена» → cancelled (${s?.message})`);
  check((await c.js('document.querySelector("#lm-bar .lm-label").textContent')) === 'Длинный камень', 'прежняя работа на месте');

  // «Не сохранять» → лист открыт, прежнее задание закрыто.
  const времяКамня = времяСостояния(камень);
  const времяЛиста = времяСостояния(лист);
  запустить([лист.файл]);
  вопрос = false;
  for (let i = 0; i < 80 && !вопрос; i++) { await пауза(100); вопрос = await c.js('!!document.querySelector(".modal-back.open .ask-text")'); }
  await c.js(`(() => { const b = [...document.querySelectorAll('.modal-back.open .btn')].find((x) => x.dataset.i18n === 'ask.discard'); b.click(); return 1; })()`);
  s = await ждатьСостояние(лист, 'opened', времяЛиста);
  check(s?.state === 'opened', '«Не сохранять» → новое задание открыто');
  const sк = await ждатьСостояние(камень, 'cancelled', времяКамня);
  check(sк?.state === 'cancelled', `прежнее задание закрыто cancelled: «${sк?.message}»`);

  // «Отменить» в полосе.
  const времяОткрытия = времяСостояния(лист);
  await пауза(1100);
  await c.js(клик('#lm-cancel'));
  s = await ждатьСостояние(лист, 'cancelled', времяОткрытия);
  check(s?.state === 'cancelled' && (await c.js('document.getElementById("lm-bar").hidden')), '«Отменить» → cancelled, полоса ушла, модель открыта');
  check((await c.js('window.__paint.viewport.paintables.length')) > 0, 'модель осталась обычной работой');

  c.close();
  app.kill();
  await app.вышел;

  // 5. Проект: новый запуск того же задания открывает проект с покраской.
  const времяДо = JSON.parse(fs.readFileSync(камень.status, 'utf8')).time;
  app = запустить([камень.файл]);
  s = await ждатьСостояние(камень, 'opened', времяДо);
  check(s?.state === 'opened', 'второе задание на ту же модель открыто');
  c = await cdp();
  const цвет = await c.js(`(() => { const [, tg] = [...window.__paint.targets][0]; const L = tg.layers[tg.activeIndex]; return [L.rgba[0], L.rgba[1], L.rgba[2], tg.layers.length]; })()`);
  check(цвет && цвет[0] === 230 && цвет[1] === 20 && цвет[2] === 30, `открыт именно проект — слой с покраской на месте (${цвет})`);

  // Модель в LevelMaker поменялась — проект чужой, открывается модель.
  c.close();
  app.kill();
  await app.вышел;
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'kid.glb'), камень.model);
  const времяДо2 = JSON.parse(fs.readFileSync(камень.status, 'utf8')).time;
  app = запустить([камень.файл]);
  s = await ждатьСостояние(камень, 'opened', времяДо2);
  c = await cdp();
  const цвет2 = await c.js(`(() => { const [, tg] = [...window.__paint.targets][0]; const L = tg.layers[tg.activeIndex]; return [L.rgba[0], L.rgba[1], L.rgba[2]]; })()`);
  check(s?.state === 'opened' && !(цвет2[0] === 230 && цвет2[1] === 20), 'проект от другой модели не открывается — открыта модель');

  // 6. С лицом: рядом с GLB — атласы и описание лица, имена — от return_to.
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fox.glb'), path.join(папка, 'Лиса.glb'));
  const лиса = задание('Лиса', { project: undefined, return_to: path.join(папка, 'Готово', 'Лиса (покраска).glb') });
  await c.js('window.__paint.state.unsaved = false');
  запустить([лиса.файл]);
  s = await ждатьСостояние(лиса, 'opened');
  check(s?.state === 'opened', 'задание с лисой пришло во второй экземпляр и открыто');
  const лицо = await c.js(`(async () => {
    const P = window.__paint;
    if (P.faceFromMaterial('Face') !== true) return 'лицо не задано';
    const f = P.state.face, i = P.viewport.paintables.findIndex((p) => p.mesh === f.mesh);
    const tg = P.targets.get(f.mesh);
    P.faceAdd('eyes', 'neutral');
    await window.__mcp.call('fill', { target: { mesh: i }, color: '#2050e0', layer: tg.layers.findIndex((L) => L.slot === 'eyes') });
    return true;
  })()`);
  check(лицо === true, `лицо задано и нарисовано (${лицо})`);
  const доЛисы = времяСостояния(лиса);
  await c.js(клик('#lm-return'));
  s = await ждатьСостояние(лиса, 'saved', доЛисы);
  const готово = path.dirname(лиса.return_to);
  const рядом = fs.readdirSync(готово).filter((f) => f.startsWith('Лиса (покраска)'));
  check(s?.state === 'saved' && рядом.includes('Лиса (покраска).glb') && рядом.includes('Лиса (покраска)_face_eyes.png') && рядом.includes('Лиса (покраска)_face.json'),
    `с лицом: GLB, атлас и json рядом (${рядом.join(', ')})`);
  if (рядом.includes('Лиса (покраска)_face.json')) {
    const описание = fs.readFileSync(path.join(готово, 'Лиса (покраска)_face.json'), 'utf8');
    check(описание.includes('Лиса (покраска)_face_eyes.png'), 'описание лица ссылается на атлас под тем же именем');
  }
  const мат = (читатьGLB(лиса.return_to)?.materials || []).map((m) => m.name);
  check(мат.includes('Face'), `в GLB материал «Face» (${мат.join(', ')})`);

  const ошибки = await c.js('window.__paint.bootErrors');
  check(!ошибки.length, `без ошибок запуска ${ошибки.length ? JSON.stringify(ошибки) : ''}`);
  c.close();
  app.kill();
  await app.вышел;

  if (провалы.length) console.log('\nЛог оболочки (хвост):\n' + app.лог.slice(-1500));
  console.log(провалы.length ? `\nПРОВАЛ: ${провалы.length}` : '\nВсё на месте.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(провалы.length ? 1 : 0);
})().catch((e) => { console.error('Ошибка проверки:', e); process.exit(2); });

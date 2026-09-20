/**
 * Сборка инструмента: состояние, связь панелей с вьюпортом, развёрткой и
 * ядром покраски.
 */

import './style.css';
import { Viewport } from './viewport.js';
import { UVEditor } from './uveditor.js';
import { ViewCube } from './viewcube.js';
import { MenuBar } from './menubar.js';
import { PaintTarget, History } from './layers.js';
import { Stroke, rectStencil, ellipseStencil, imageStencil } from './painter.js';
import * as THREE from 'three';
import { floodFaces } from './mesh-cache.js';
import * as UI from './ui.js';
import { createBrushModal, createMaterialModal, createHelpModal } from './modals.js';
import { drawMaterialBall } from './matball.js';

// Сбор ошибок с самого начала загрузки: в консоли браузера вперемешку лежат
// сообщения от прошлых версий модулей, и по ней не понять, живая ошибка или
// след горячей перезагрузки.
const bootErrors = [];
window.addEventListener('error', (e) => bootErrors.push(e.message));
window.addEventListener('unhandledrejection', (e) => bootErrors.push('promise: ' + e.reason));

const $ = (id) => document.getElementById(id);
const app = $('app');

/**
 * Лежит ли цель события внутри узла.
 * Node.contains() бросает исключение, если ему дать не узел, — а целью
 * события вполне может оказаться само окно. Раньше это исключение обрывало
 * обработчик мазка на полуслове.
 */
const inside = (node, target) => target instanceof Node && node.contains(target);

/* ── Состояние ─────────────────────────────────────────────────── */

const state = {
  tool: 'brush',
  // Материал, которым красим: цвет плюс поверхность. Кисть несёт его целиком,
  // поэтому «покрасить железом» делает железной только закрашенную область.
  color: [200, 86, 60],
  roughness: 0.9,
  metalness: 0,
  opacity: 1,                 // прозрачность самого материала (стекло)
  color2: [120, 50, 34],      // второй цвет узора
  pattern: { id: 'none', scale: 8, contrast: 1 },
  texture: null,              // своя картинка для покраски: {data, w, h, name}
  matName: 'Краска',
  // Фигуры и текст: чем печатаем и какой толщины.
  shape: { outline: false, thickness: 4, text: 'Текст', font: 96 },
  pivot: 'local',             // вокруг чего вращаем вид
  sizePct: 4,        // диаметр кисти в % от габарита модели
  // Кисть одним объектом: её же получают ядро покраски и окно кистей.
  brush: { hardness: 0.7, flow: 1, grain: 0, shape: 'round', spacing: 0.25, scatter: 0 },
  frontOnly: true,
  fillAngle: 40,
  activeLayer: 0,
  texSize: 1024,
  showWire: true,
  display: 'material',
  grid: true,
  vertices: false,
  uvOpen: false,
  painted: false,
};

const viewport = new Viewport($('viewport'));
const history = new History(40);

/** meshUUID -> PaintTarget. У каждого меша своя текстура: развёртки совпадают. */
const targets = new Map();
let activeMesh = null;
let modelName = '—';

const uvEditor = new UVEditor($('uv-body'), {
  currentTool: () => state.tool,
  brushRadiusScreen: () => uvBrushRadiusTexels() * uvEditor.view.scale / (activeTarget()?.size || 1024),
  onBegin: uvBegin,
  onMove: uvMove,
  onEnd: uvEnd,
  onFill: uvFill,
  onPick: uvPick,
});

/* ── Настройки интерфейса переживают перезагрузку ──────────────── */

const PREFS = 'paint-tool.ui';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; }
}
function savePrefs(patch) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* приватный режим */ }
}

/* ── Слои: структура общая для всех мешей модели ───────────────── */

function eachTarget(fn) { targets.forEach(fn); }
function activeTarget() { return activeMesh ? targets.get(activeMesh) : null; }
function refLayers() { const t = activeTarget(); return t ? t.layers : null; }

function buildTargets(paintables) {
  targets.forEach((t) => t.dispose());
  targets.clear();

  // Много мешей на крупной текстуре съедят память: 2048² × RGBA = 16 МБ на
  // слой на меш. Для уровня с десятком объектов сбрасываем размер сами.
  let size = state.texSize;
  let downgraded = false;
  if (paintables.length > 8 && size > 512) { size = 512; downgraded = true; }

  for (const { mesh } of paintables) {
    const t = new PaintTarget(size);
    targets.set(mesh, t);
    viewport.applyPaintMaterial(mesh, t);
  }

  state.activeLayer = 0;
  activeMesh = paintables.length ? paintables[0].mesh : null;
  history.clear();
  state.painted = false;
  return downgraded ? size : null;
}

function addLayer() {
  eachTarget((t) => { t.activeIndex = state.activeLayer; t.addLayer(); });
  state.activeLayer += 1;
  syncLayers();
}

function removeLayer() {
  const first = targets.values().next().value;
  if (!first || first.layers.length <= 1) return;

  // Записи журнала держат ссылку на сам слой: после удаления они вели бы
  // правку в никуда. Чистим их, чтобы история не врала.
  const doomed = new Set();
  eachTarget((t) => doomed.add(t.layers[state.activeLayer]));
  history.prune((e) => !doomed.has(e.layer));

  eachTarget((t) => t.removeLayer(state.activeLayer));
  state.activeLayer = Math.min(state.activeLayer, first.layers.length - 1);
  syncLayers();
  refreshUV();
}

function setActiveLayer(i) {
  state.activeLayer = i;
  eachTarget((t) => { t.activeIndex = i; });
  syncLayers();
}

/* ── Размеры кисти ─────────────────────────────────────────────── */

function brushRadiusWorld() {
  return ((viewport.modelSize || 1) * state.sizePct) / 200;
}

/** Радиус кисти в пикселях экрана — по нему выбираем шаг мазка. */
function brushRadiusScreen() {
  const cam = viewport.camera;
  const h = viewport.container.clientHeight || 1;
  if (cam.isOrthographicCamera) {
    return brushRadiusWorld() / ((cam.top - cam.bottom) / cam.zoom / h);
  }
  const dist = cam.position.distanceTo(viewport.controls.target) || 1;
  const worldPerPixel = (2 * Math.tan((cam.fov * Math.PI) / 360) * dist) / h;
  return brushRadiusWorld() / worldPerPixel;
}

/** В развёртке кисть меряется текселями: она рисует по текстуре, не по форме. */
function uvBrushRadiusTexels() {
  const t = activeTarget();
  return ((t ? t.size : 1024) * state.sizePct) / 200;
}

/* ── Мазок ─────────────────────────────────────────────────────── */

let stroke = null;
let strokeMesh = null;
let lastScreen = null;
let lastTexel = null;
let pumpId = 0;
let perfMs = 0;

function strokeOpts(shift) {
  const mask = state.tool === 'mask';
  return {
    channel: mask ? 'mask' : 'rgba',
    mode: mask ? (shift ? 'mask-add' : 'mask-sub')
        : state.tool === 'eraser' ? 'erase' : 'paint',
    color: state.color,
    // Сила мазка живёт в кисти («Нажим»), у материала её нет: два ползунка
    // про «насколько сильно» рядом друг с другом только путали.
    opacity: 1,
    roughness: state.roughness,
    metalness: state.metalness,
    opacity: state.opacity,
    pattern: state.pattern,
    color2: state.color2,
    texture: state.texture,
  };
}

function toolLabel() {
  return { brush: 'Кисть', eraser: 'Ластик', mask: 'Маска',
           'fill-faces': 'Заливка граней', 'fill-island': 'Заливка острова',
           'fill-layer': 'Заливка слоя',
           rect: 'Прямоугольник', ellipse: 'Круг', text: 'Текст' }[state.tool] || 'Правка';
}

const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'text']);

/**
 * Перенос накопленного в текстуру — раз в кадр.
 *
 * За один взмах мыши отпечатков ставятся десятки, и каждая сборка тянет
 * перезаливку текстуры на видеокарту. Именно на этом инструмент тормозил.
 */
let pumpFrame = 0;
function pump() {
  if (!stroke) { pumpId = 0; return; }
  const t0 = performance.now();
  const changed = stroke.flush();
  if (changed) {
    perfMs = perfMs * 0.8 + (performance.now() - t0) * 0.2;
    if (state.uvOpen) uvEditor.draw();
    // Превью — целая текстура в маленький квадрат; каждый кадр ни к чему.
    if ((pumpFrame++ % 6) === 0) {
      UI.drawUVPreview($('uv-preview'), activeTarget(), activeMesh?.userData.paintCache, state.showWire);
    }
    syncPerf();
  }
  pumpId = requestAnimationFrame(pump);
}
function startPump() { if (!pumpId) pumpId = requestAnimationFrame(pump); }

function beginStroke(target, cache, mesh, shift) {
  target.activeIndex = state.activeLayer;
  stroke = new Stroke(target, cache, strokeOpts(shift));
  strokeMesh = mesh;
  lastScreen = null;
  lastTexel = null;
  startPump();
}

function endStroke() {
  if (!stroke) return;
  const entry = stroke.end(toolLabel());
  if (entry) history.push(entry);
  stroke = null; strokeMesh = null; lastScreen = null; lastTexel = null;
  if (pumpId) { cancelAnimationFrame(pumpId); pumpId = 0; }
  viewport.syncTransparency();
  refreshUV();
}

/* Мазок во вьюпорте ------------------------------------------------ */

function dabAtScreen(x, y) {
  // Разброс сдвигает каждый отпечаток — так кисть перестаёт быть лентой.
  const sc = state.brush.scatter || 0;
  if (sc) {
    const r = brushRadiusScreen() * sc;
    x += (Math.random() * 2 - 1) * r;
    y += (Math.random() * 2 - 1) * r;
  }
  const hit = viewport.pick(x, y);
  if (!hit || hit.mesh !== strokeMesh) return;
  stroke.dab(hit.local, brushRadiusWorld() / hit.scale, hit.viewDir,
             state.brush, state.frontOnly, hit.basis);
  state.painted = true;
}

/**
 * Продолжение мазка. Промежуток между событиями мыши добиваем шагами
 * ПО ЭКРАНУ, заново бросая луч на каждом шаге.
 *
 * Интерполировать по прямой в пространстве нельзя: когда курсор перескакивает
 * с крыши на стену, прямая между двумя точками проходит сквозь объём дома, и
 * кисть мажет изнутри — по дальним стенам, где её не вели.
 */
function strokeMove(x, y) {
  if (!stroke) return;
  if (lastScreen) {
    const dx = x - lastScreen.x, dy = y - lastScreen.y;
    const dist = Math.hypot(dx, dy);
    const spacing = Math.max(1.2, brushRadiusScreen() * (state.brush.spacing ?? 0.25));
    const steps = Math.min(120, Math.max(1, Math.ceil(dist / spacing)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      dabAtScreen(lastScreen.x + dx * t, lastScreen.y + dy * t);
    }
  } else {
    dabAtScreen(x, y);
  }
  lastScreen = { x, y };
}

/* Мазок в развёртке ------------------------------------------------ */

function uvBegin(tx, ty, shift) {
  const target = activeTarget();
  if (!target || !activeMesh) return;
  beginStroke(target, activeMesh.userData.paintCache, activeMesh, shift);
  uvMove(tx, ty);
}

function uvMove(tx, ty) {
  if (!stroke) return;
  const r = uvBrushRadiusTexels();
  const sc = (state.brush.scatter || 0) * r;
  const jitter = (v) => (sc ? v + (Math.random() * 2 - 1) * sc : v);

  if (lastTexel) {
    const dx = tx - lastTexel.x, dy = ty - lastTexel.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, r * (state.brush.spacing ?? 0.25));
    const steps = Math.min(200, Math.max(1, Math.ceil(dist / step)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stroke.dab2D(jitter(lastTexel.x + dx * t), jitter(lastTexel.y + dy * t), r, state.brush);
    }
  } else {
    stroke.dab2D(jitter(tx), jitter(ty), r, state.brush);
  }
  lastTexel = { x: tx, y: ty };
  state.painted = true;
}

function uvEnd() { endStroke(); }

function uvFill(tri) {
  const target = activeTarget();
  if (!target || !activeMesh) return;
  const cache = activeMesh.userData.paintCache;
  if (tri < 0 && state.tool !== 'fill-layer') { setStatusHint('мимо развёртки'); return; }
  runFill(target, cache, tri);
}

function uvPick(tx, ty) {
  const target = activeTarget();
  if (!target) return;
  const S = target.size;
  // Пипетка берёт материал целиком: цвет и поверхность под ним.
  setMaterial({ ...target.sampleMaterialUV(tx / S, 1 - ty / S), name: 'С модели' });
}

/* Заливки ---------------------------------------------------------- */

function runFill(target, cache, faceIndex) {
  target.activeIndex = state.activeLayer;
  const s = new Stroke(target, cache, strokeOpts(false));

  if (state.tool === 'fill-layer') {
    s.fillAll();
  } else {
    const island = state.tool === 'fill-island';
    const set = floodFaces(cache, faceIndex,
      island ? 180 : state.fillAngle, island ? 'uv' : 'geom');
    s.fillTriangles(set);
    setStatusHint(`залито граней: ${set.size}`);
  }

  const entry = s.end(toolLabel());
  if (entry) history.push(entry);
  state.painted = true;
  viewport.syncTransparency();
  refreshUV();
}

/* ── Фигуры и текст ────────────────────────────────────────────── */

/** Картинка с надписью — из неё получается трафарет для печати текста. */
function renderText(text, fontPx) {
  const pad = Math.ceil(fontPx * 0.25);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const font = `700 ${fontPx}px -apple-system, "SF Pro Text", system-ui, sans-serif`;

  ctx.font = font;
  const m = ctx.measureText(text);
  c.width = Math.max(1, Math.ceil(m.width) + pad * 2);
  c.height = Math.ceil(fontPx * 1.35) + pad * 2;

  const x = c.getContext('2d', { willReadFrequently: true });
  x.font = font;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillStyle = '#fff';
  x.fillText(text, c.width / 2, c.height / 2);

  return { data: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

/**
 * Трафарет выбранной фигуры в координатах экрана (или текселей — считается
 * одинаково, меняется только система координат).
 */
function shapeStencil(kind, a, b) {
  const { outline, thickness, text, font } = state.shape;
  if (kind === 'rect') return rectStencil(a.x, a.y, b.x, b.y, outline, thickness);
  if (kind === 'ellipse') return ellipseStencil(a.x, a.y, b.x, b.y, outline, thickness);

  // Текст: тянем — задаём кегль высотой протяжки, щёлкаем — берём из панели.
  const h = Math.abs(b.y - a.y);
  const px = Math.max(8, h > 6 ? h : font);
  const img = renderText(text || 'Текст', px);
  return { fn: imageStencil(img.data, img.w, img.h, a.x - img.w / 2, a.y - img.h / 2), img };
}

/** Напечатать фигуру по поверхности — через проекцию на экран. */
function applyShape3D(mesh, a, b) {
  const target = targets.get(mesh);
  const cache = mesh.userData.paintCache;
  if (!target || !cache) return;
  target.activeIndex = state.activeLayer;

  const cam = viewport.camera;
  const canvas = viewport.renderer.domElement;
  cam.updateMatrixWorld();
  mesh.updateMatrixWorld();

  // Матрица «локальные координаты меша → экран».
  const mvp = new THREE.Matrix4()
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    .multiply(mesh.matrixWorld);

  // Направление взгляда в осях меша — по нему отбрасываем отвёрнутые грани.
  const inv = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
  const viewDir = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(cam.quaternion).applyMatrix3(inv).normalize();

  const st = shapeStencil(state.tool, a, b);
  const fn = st.fn || st;

  const s = new Stroke(target, cache, strokeOpts(false));
  s.stampProjected(mvp.elements, canvas.clientWidth, canvas.clientHeight,
                   fn, viewDir, state.brush, state.frontOnly);

  const entry = s.end(toolLabel());
  if (entry) history.push(entry);
  else setStatusHint('фигура не легла на модель');
  state.painted = true;
  viewport.syncTransparency();
  refreshUV();
}

/* Предпросмотр рамки поверх вьюпорта */
const preview = $('shape-preview');
function showPreview(kind, a, b) {
  const r = el.getBoundingClientRect();
  preview.className = 'on' + (kind === 'ellipse' ? ' ellipse' : '');
  preview.style.left = Math.min(a.cx, b.cx) - r.left + 'px';
  preview.style.top = Math.min(a.cy, b.cy) - r.top + 'px';
  preview.style.width = Math.abs(b.cx - a.cx) + 'px';
  preview.style.height = Math.abs(b.cy - a.cy) + 'px';
}
function hidePreview() { preview.className = ''; }

/* ── Ввод во вьюпорте ──────────────────────────────────────────── */

const el = $('viewport');
let spaceDown = false;
let shapeDrag = null;

// Перехват в фазе погружения: иначе орбита успевает схватить нажатие раньше
// нас и модель уезжает вместо мазка.
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;      // вращение и сдвиг — не наше дело
  if (spaceDown) return;           // пробел + ЛКМ — перемещение
  // Оверлей вида лежит внутри вьюпорта, а перехват у нас в фазе погружения:
  // без этой проверки щелчок по кнопке вида заодно ставил бы мазок.
  if (inside($('view-overlay'), e.target)) return;
  const hit = viewport.pick(e.clientX, e.clientY);
  if (!hit) return;                // мимо модели — красить нечего

  e.stopPropagation();
  e.preventDefault();
  // Захват указателя — удобство (мазок продолжается за краем окна), но не
  // условие работы: на некоторых указателях он бросает исключение, и тогда
  // без try весь мазок не начинался бы вовсе.
  try { viewport.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* не беда */ }
  setActiveMesh(hit.mesh);

  switch (state.tool) {
    case 'eyedropper': {
      const t = targets.get(hit.mesh);
      if (t && hit.uv) setMaterial({ ...t.sampleMaterialUV(hit.uv.x, hit.uv.y), name: 'С модели' });
      break;
    }
    case 'fill-faces':
    case 'fill-island':
    case 'fill-layer': {
      const t = targets.get(hit.mesh);
      if (t) runFill(t, hit.cache, hit.faceIndex);
      break;
    }
    case 'rect':
    case 'ellipse':
    case 'text': {
      const cr = viewport.renderer.domElement.getBoundingClientRect();
      const pt = { x: e.clientX - cr.left, y: e.clientY - cr.top, cx: e.clientX, cy: e.clientY };
      shapeDrag = { mesh: hit.mesh, kind: state.tool, a: pt, b: pt };
      break;
    }
    default: {
      const t = targets.get(hit.mesh);
      if (!t) break;
      beginStroke(t, hit.cache, hit.mesh, e.shiftKey);
      strokeMove(e.clientX, e.clientY);
    }
  }
}, true);

window.addEventListener('pointermove', (e) => {
  // Луч бьём только когда курсор над вьюпортом: поиск попадания на каждое
  // движение мыши по всему окну — лишняя работа на ровном месте.
  const r = el.getBoundingClientRect();
  const over = e.clientX >= r.left && e.clientX <= r.right
            && e.clientY >= r.top && e.clientY <= r.bottom
            && !inside($('view-overlay'), e.target);
  if (!over && !stroke) { viewport.hideCursor(); return; }

  if (shapeDrag) {
    const cr = viewport.renderer.domElement.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    // Shift равняет стороны: квадрат и правильный круг.
    if (e.shiftKey && shapeDrag.kind !== 'text') {
      const d = Math.max(Math.abs(x - shapeDrag.a.cx), Math.abs(y - shapeDrag.a.cy));
      x = shapeDrag.a.cx + Math.sign(x - shapeDrag.a.cx || 1) * d;
      y = shapeDrag.a.cy + Math.sign(y - shapeDrag.a.cy || 1) * d;
    }
    shapeDrag.b = { x: x - cr.left, y: y - cr.top, cx: x, cy: y };
    showPreview(shapeDrag.kind, shapeDrag.a, shapeDrag.b);
    return;
  }

  if (stroke && strokeMesh) {
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const p of (pts.length ? pts : [e])) strokeMove(p.clientX, p.clientY);
  }
  if (over) viewport.showCursor(viewport.pick(e.clientX, e.clientY), brushRadiusWorld());
});

window.addEventListener('pointerup', () => {
  if (shapeDrag) {
    hidePreview();
    applyShape3D(shapeDrag.mesh, shapeDrag.a, shapeDrag.b);
    shapeDrag = null;
    return;
  }
  if (stroke) endStroke();
});
el.addEventListener('contextmenu', (e) => e.preventDefault());

/* ── Сворачиваемые секции ──────────────────────────────────────── */

document.querySelectorAll('.section > h3').forEach((h) => {
  h.addEventListener('click', () => {
    const s = h.parentElement;
    const open = s.dataset.open === '1' ? '0' : '1';
    s.dataset.open = open;
    const prefs = loadPrefs();
    prefs.sections = { ...(prefs.sections || {}), [s.dataset.key]: open };
    savePrefs(prefs);
  });
});

/* ── Инструменты ───────────────────────────────────────────────── */

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  syncLayers();
}
document.querySelectorAll('.tool').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});

/* ── Кисть и цвет ──────────────────────────────────────────────── */

function syncBrushLabels() {
  const d = (viewport.modelSize || 1) * state.sizePct / 100;
  $('brush-size-val').textContent = UI.formatSize(d);
  $('brush-hardness-val').textContent = Math.round(state.brush.hardness * 100) + '%';
  $('brush-flow-val').textContent = Math.round(state.brush.flow * 100) + '%';
  $('brush-size').value = state.sizePct;
  $('brush-hardness').value = Math.round(state.brush.hardness * 100);
  $('brush-flow').value = Math.round(state.brush.flow * 100);
}

$('brush-size').addEventListener('input', (e) => { state.sizePct = +e.target.value; syncBrushLabels(); uvEditor.draw(); });
$('brush-hardness').addEventListener('input', (e) => { state.brush.hardness = +e.target.value / 100; syncBrushLabels(); });
$('brush-flow').addEventListener('input', (e) => { state.brush.flow = +e.target.value / 100; syncBrushLabels(); });
$('brush-frontface').addEventListener('change', (e) => { state.frontOnly = e.target.checked; });
function syncShapeUI() {
  $('shape-fill').classList.toggle('on', !state.shape.outline);
  $('shape-outline').classList.toggle('on', state.shape.outline);
  $('shape-thickness-val').textContent = state.shape.thickness + ' px';
  $('shape-font-val').textContent = state.shape.font + ' px';
}
$('shape-fill').addEventListener('click', () => { state.shape.outline = false; syncShapeUI(); });
$('shape-outline').addEventListener('click', () => { state.shape.outline = true; syncShapeUI(); });
$('shape-thickness').addEventListener('input', (e) => { state.shape.thickness = +e.target.value; syncShapeUI(); });
$('shape-font').addEventListener('input', (e) => { state.shape.font = +e.target.value; syncShapeUI(); });
$('shape-text').addEventListener('input', (e) => { state.shape.text = e.target.value; });

$('fill-angle').addEventListener('input', (e) => {
  state.fillAngle = +e.target.value;
  $('fill-angle-val').textContent = e.target.value + '°';
});

function setColor(rgb) { setMaterial({ color: rgb, name: 'Краска' }); }

/**
 * Сменить материал кисти целиком или частями.
 * @param {object} patch {color, color2, pattern, roughness, metalness, opacity, alpha, name}
 */
function setMaterial(patch) {
  if (patch.color) state.color = patch.color;
  if (patch.color2) state.color2 = patch.color2;
  if (patch.pattern) state.pattern = { ...state.pattern, ...patch.pattern };
  if (patch.texture !== undefined) state.texture = patch.texture;
  if (patch.roughness != null) state.roughness = patch.roughness;
  if (patch.metalness != null) state.metalness = patch.metalness;
  if (patch.opacity != null) state.opacity = patch.opacity;
  if (patch.name) state.matName = patch.name;

  // Второй цвет узора по умолчанию — затемнение основного.
  if (patch.color && !patch.color2) {
    state.color2 = state.color.map((v) => Math.round(v * 0.55));
  }

  syncMaterialChip();
}

/**
 * Шар и подпись текущего материала в боковой панели.
 * Панель показывает именно материал, а не просто цвет: цвет — лишь одно из
 * его свойств, рядом живут узор, поверхность и прозрачность.
 */
function syncMaterialChip() {
  drawMaterialBall($('mat-chip-ball'), {
    color: state.color, color2: state.color2, pattern: state.pattern,
    texture: state.texture,
    roughness: state.roughness, metalness: state.metalness,
    alpha: state.opacity, checker: true,
  });

  $('mat-chip-name').textContent = state.matName;

  const bits = [UI.rgbToHex(state.color).toUpperCase()];
  bits.push(`шерох. ${Math.round(state.roughness * 100)}%`);
  if (state.metalness > 0.01) bits.push(`металл ${Math.round(state.metalness * 100)}%`);
  if (state.opacity < 0.99) bits.push(`прозр. ${Math.round((1 - state.opacity) * 100)}%`);
  if (state.pattern.id === 'image') bits.push('своя текстура');
  else if (state.pattern.id !== 'none') bits.push('узор');
  $('mat-chip-sub').textContent = bits.join(' · ');
}

// Быстрая палитра — это обычная краска: цвет, матовая поверхность, без узора.
UI.renderSwatches($('quick-mats'), (hex) => setMaterial({
  color: UI.hexToRgb(hex),
  pattern: { id: 'none' },
  roughness: 0.9, metalness: 0, opacity: 1,
  name: `Краска · ${hex.toUpperCase()}`,
}));

/* ── Слои ──────────────────────────────────────────────────────── */

function syncLayers() {
  UI.renderLayers($('layer-list'), activeTarget(),
    { activeIndex: state.activeLayer, maskEditing: state.tool === 'mask' },
    {
      onSelect: setActiveLayer,
      onToggleVisible: (i) => {
        const vis = !refLayers()[i].visible;
        eachTarget((t) => { t.layers[i].visible = vis; t.compositeRect(null); });
        syncLayers(); refreshUV();
      },
      onRename: (i, name) => { eachTarget((t) => { t.layers[i].name = name; }); syncLayers(); },
      onToggleMaskEdit: (i) => {
        setActiveLayer(i);
        eachTarget((t) => t.layers[i].ensureMask(t.size));
        setTool(state.tool === 'mask' ? 'brush' : 'mask');
      },
    });

  const L = refLayers();
  $('layer-count').textContent = L ? String(L.length) : '';
  if (L) {
    const cur = L[state.activeLayer];
    $('layer-opacity').value = Math.round(cur.opacity * 100);
    $('layer-opacity-val').textContent = Math.round(cur.opacity * 100) + '%';
    $('layer-blend').value = cur.blend;
  }
}

$('btn-layer-add').addEventListener('click', addLayer);
$('btn-layer-del').addEventListener('click', removeLayer);
$('btn-layer-mask').addEventListener('click', () => {
  if (!targets.size) return;
  eachTarget((t) => t.layers[state.activeLayer].ensureMask(t.size));
  setTool('mask');
  syncLayers();
});
$('layer-opacity').addEventListener('input', (e) => {
  const v = +e.target.value / 100;
  $('layer-opacity-val').textContent = e.target.value + '%';
  eachTarget((t) => { t.layers[state.activeLayer].opacity = v; t.compositeRect(null); });
  scheduleUV();
});
function setBlend(v) {
  eachTarget((t) => { t.layers[state.activeLayer].blend = v; t.compositeRect(null); });
  $('layer-blend').value = v;
  scheduleUV();
}
function currentBlend() {
  const L = refLayers();
  return L ? L[state.activeLayer].blend : 'normal';
}
$('layer-blend').addEventListener('change', (e) => setBlend(e.target.value));

/* ── История ───────────────────────────────────────────────────── */

history.onChange = () => { renderHistory(); syncHistoryButtons(); viewport.syncTransparency(); refreshUV(); };

function renderHistory() {
  const list = $('history-list');
  list.innerHTML = '';

  const row = (label, idx) => {
    const d = document.createElement('div');
    d.className = 'hist' + (idx === history.index ? ' current' : (idx > history.index ? ' future' : ''));
    d.innerHTML = '<span class="dot"></span>';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = label;
    d.appendChild(t);
    d.addEventListener('click', () => history.goto(idx));
    list.appendChild(d);
  };

  row('Исходное состояние', -1);
  history.entries.forEach((e, i) => row(`${i + 1}. ${e.label}`, i));

  $('history-count').textContent = history.entries.length ? String(history.entries.length) : '';
  const cur = list.querySelector('.hist.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function syncHistoryButtons() {
  for (const id of ['btn-undo', 'btn-hist-undo']) $(id).disabled = !history.canUndo;
  for (const id of ['btn-redo', 'btn-hist-redo']) $(id).disabled = !history.canRedo;
}
$('btn-undo').addEventListener('click', () => history.undo());
$('btn-redo').addEventListener('click', () => history.redo());
$('btn-hist-undo').addEventListener('click', () => history.undo());
$('btn-hist-redo').addEventListener('click', () => history.redo());

/* ── Развёртка ─────────────────────────────────────────────────── */

function setUVOpen(open) {
  state.uvOpen = open;
  app.classList.toggle('uv-open', open);
  $('btn-uv').classList.toggle('on', open);
  savePrefs({ uvOpen: open });
  if (open) {
    requestAnimationFrame(() => { uvEditor.resize(); refreshUV(); });
  }
  viewport.resize();
}

$('btn-uv').addEventListener('click', () => setUVOpen(!state.uvOpen));
$('uv-close').addEventListener('click', () => setUVOpen(false));
$('uv-fit').addEventListener('click', () => { uvEditor.fit(); uvEditor.draw(); });
$('uv-wire').addEventListener('change', (e) => setShowWire(e.target.checked));
$('uv-preview-wire').addEventListener('change', (e) => setShowWire(e.target.checked));
$('btn-uv-open').addEventListener('click', (e) => { e.stopPropagation(); setUVOpen(true); });
$('uv-preview-box').addEventListener('click', () => setUVOpen(true));

let uvPending = false;
function scheduleUV() {
  if (uvPending) return;
  uvPending = true;
  requestAnimationFrame(() => { uvPending = false; refreshUV(); });
}
function refreshUV() {
  // Маленькая карта в панели нужна и при закрытом редакторе: по ней видно,
  // куда легла краска и много ли пустого места на атласе.
  UI.drawUVPreview($('uv-preview'), activeTarget(), activeMesh?.userData.paintCache, state.showWire);
  if (!state.uvOpen) return;
  uvEditor.setTarget(activeTarget(), activeMesh?.userData.paintCache);
  $('uv-mesh').textContent = activeMesh?.name ? `· ${activeMesh.name}` : '';
}

function setShowWire(on) {
  state.showWire = on;
  $('uv-wire').checked = on;
  $('uv-preview-wire').checked = on;
  uvEditor.setShowWire(on);
  refreshUV();
}

/* Сплиттер — ширина панели развёртки */
$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const panes = $('panes');
  const sp = $('splitter');
  sp.setPointerCapture(e.pointerId);
  sp.classList.add('dragging');

  const onMove = (ev) => {
    const r = panes.getBoundingClientRect();
    const pct = Math.max(18, Math.min(80, ((r.right - ev.clientX) / r.width) * 100));
    document.documentElement.style.setProperty('--uv-width', pct + '%');
    viewport.resize();
    uvEditor.resize();
  };
  const onUp = () => {
    sp.classList.remove('dragging');
    sp.removeEventListener('pointermove', onMove);
    sp.removeEventListener('pointerup', onUp);
    savePrefs({ uvWidth: getComputedStyle(document.documentElement).getPropertyValue('--uv-width') });
  };
  sp.addEventListener('pointermove', onMove);
  sp.addEventListener('pointerup', onUp);
});

/* ── Вид: оверлей, куб ориентации, список видов ────────────────── */

// Куб показывает, с какой стороны смотрит камера, и сам служит переключателем:
// грань — осевой вид, ребро — под 45°, угол — изометрия.
const viewCube = new ViewCube($('viewcube-host'), {
  onPick: (dir) => { viewport.setViewDirection(dir); syncViewUI(); },
  onOrbit: (dx, dy) => { viewport.orbitBy(dx, dy); syncViewUI(); },
});
viewport.afterRender = () => viewCube.sync(viewport.camera);

/**
 * Точка, вокруг которой вращается и приближается вид.
 * @param {'world'|'local'|'camera'} mode
 */
function setPivot(mode) {
  state.pivot = mode;
  viewport.setPivotMode(mode);
  document.querySelectorAll('#pivot-seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.pivot === mode);
  });
  savePrefs({ pivot: mode });
}

document.querySelectorAll('#pivot-seg button').forEach((b) => {
  b.addEventListener('click', () => setPivot(b.dataset.pivot));
});

function applyView(name) { viewport.setView(name); syncViewUI(); }

function setProjection(kind) { viewport.setProjection(kind); syncViewUI(); }

function setDisplayMode(mode) {
  state.display = mode;
  viewport.setDisplayMode(mode);
  syncViewUI();
}

function setGrid(on) { state.grid = on; viewport.setGridVisible(on); syncViewUI(); }

function setVertices(on) { state.vertices = on; viewport.setVerticesVisible(on); syncViewUI(); }

function syncViewUI() {
  const cur = viewport.currentViewName();
  document.querySelectorAll('#view-flyout button').forEach((b) => {
    // «3/4» не подсвечиваем по совпадению: любой свободный разворот тоже
    // «не осевой», и кнопка горела бы всё время.
    b.classList.toggle('on', cur !== 'user' && b.dataset.view === cur);
  });
  $('ov-proj').classList.toggle('on', viewport.projection === 'ortho');
  $('ov-display').classList.toggle('on', state.display === 'flat');
  $('ov-grid').classList.toggle('on', state.grid);
  $('ov-verts').classList.toggle('on', state.vertices);
}

const flyout = $('view-flyout');
function closeFlyout() { flyout.classList.remove('open'); $('ov-views').classList.remove('on'); }

$('ov-views').addEventListener('click', () => {
  const open = flyout.classList.toggle('open');
  $('ov-views').classList.toggle('on', open);
});
document.addEventListener('pointerdown', (e) => {
  if (!flyout.classList.contains('open')) return;
  if (inside(flyout, e.target) || inside($('ov-views'), e.target)) return;
  closeFlyout();
});
document.querySelectorAll('#view-flyout button').forEach((b) => {
  b.addEventListener('click', () => { applyView(b.dataset.view); closeFlyout(); });
});

$('ov-center').addEventListener('click', () => viewport.centerCamera());
$('ov-proj').addEventListener('click', () => setProjection(viewport.projection === 'ortho' ? 'persp' : 'ortho'));
$('ov-display').addEventListener('click', () => setDisplayMode(state.display === 'flat' ? 'material' : 'flat'));
$('ov-grid').addEventListener('click', () => setGrid(!state.grid));
$('ov-verts').addEventListener('click', () => setVertices(!state.vertices));

/* ── Панели ────────────────────────────────────────────────────── */

function togglePanel(cls, btn) {
  const off = app.classList.toggle(cls);
  btn.classList.toggle('on', !off);
  savePrefs({ [cls]: off });
  viewport.resize();
  if (state.uvOpen) uvEditor.resize();
}
$('btn-tools-toggle').addEventListener('click', () => togglePanel('no-tools', $('btn-tools-toggle')));
$('btn-side-toggle').addEventListener('click', () => togglePanel('no-side', $('btn-side-toggle')));

function toggleAllPanels() {
  const hide = !app.classList.contains('no-side');
  app.classList.toggle('no-side', hide);
  app.classList.toggle('no-tools', hide);
  $('btn-side-toggle').classList.toggle('on', !hide);
  $('btn-tools-toggle').classList.toggle('on', !hide);
  savePrefs({ 'no-side': hide, 'no-tools': hide });
  viewport.resize();
  if (state.uvOpen) uvEditor.resize();
}

/* Ширина правой панели тянется за ручку */
$('side-splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const sp = $('side-splitter');
  try { sp.setPointerCapture(e.pointerId); } catch { /* не беда */ }
  sp.classList.add('dragging');

  const onMove = (ev) => {
    const w = Math.max(190, Math.min(560, window.innerWidth - ev.clientX));
    document.documentElement.style.setProperty('--side-w', w + 'px');
    viewport.resize();
    if (state.uvOpen) uvEditor.resize();
    refreshUV();
  };
  const onUp = () => {
    sp.classList.remove('dragging');
    sp.removeEventListener('pointermove', onMove);
    sp.removeEventListener('pointerup', onUp);
    savePrefs({ sideWidth: getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim() });
  };
  sp.addEventListener('pointermove', onMove);
  sp.addEventListener('pointerup', onUp);
});

/* ── Окна кистей и материалов ──────────────────────────────────── */

const brushModal = createBrushModal({
  getBrush: () => state.brush,
  setBrush: (patch) => { Object.assign(state.brush, patch); syncBrushLabels(); },
  getColor: () => state.color,
  getSizePct: () => state.sizePct,
  setSizePct: (v) => { state.sizePct = v; syncBrushLabels(); },
  sizeLabel: (v) => UI.formatSize((viewport.modelSize || 1) * v / 100),
});

const materialModal = createMaterialModal({
  getMaterial: () => ({
    color: state.color,
    color2: state.color2,
    pattern: state.pattern,
    texture: state.texture,
    opacity: state.opacity,
    roughness: state.roughness,
    metalness: state.metalness,
    name: state.matName,
  }),
  setMaterial: (patch) => setMaterial(patch),
});

const helpModal = createHelpModal();

// Кнопки сидят в заголовках секций, а заголовок сворачивает секцию —
// нажатие до него доходить не должно.
$('btn-brush-modal').addEventListener('click', (e) => { e.stopPropagation(); brushModal.open(); });
$('btn-material-modal').addEventListener('click', (e) => { e.stopPropagation(); materialModal.open(); });
$('mat-chip').addEventListener('click', () => materialModal.open());

/* ── Модель ────────────────────────────────────────────────────── */

function setActiveMesh(mesh) {
  if (activeMesh === mesh) return;
  activeMesh = mesh;
  syncLayers();
  refreshUV();
  syncStatusModel();
}

function afterModelLoaded(report) {
  const downgraded = buildTargets(viewport.paintables);
  modelName = report.name;

  syncLayers();
  syncBrushLabels();
  renderHistory();
  syncHistoryButtons();
  syncStatusModel();
  syncPerf();
  if (state.uvOpen) { uvEditor.setTarget(null, null); refreshUV(); uvEditor.fit(); uvEditor.draw(); }

  $('stat-tris').textContent = `${(report.tris || 0).toLocaleString('ru')} трис · ${report.meshes} меш(ей)`;

  const notes = [];
  if (downgraded) notes.push(`мешей много — текстура ${downgraded}`);
  if (report.noUV?.length) notes.push(`без развёртки, не красится: ${report.noUV.join(', ')}`);
  if (report.overlapping?.length) {
    // Наложенная развёртка — не мелочь: мазок по одной грани проступит на
    // другой. Лучше сказать сразу, чем гадать, почему кисть «мажет мимо».
    const worst = Math.round(Math.max(...report.overlapping.map((o) => o.ratio)) * 100);
    notes.push(`⚠ развёртка с наложением (${worst}%): ${report.overlapping.map((o) => o.name).join(', ')} — мазок продублируется`);
  }
  const uvEl = $('stat-uv');
  uvEl.textContent = notes.join(' · ');
  uvEl.style.color = report.overlapping?.length ? 'var(--danger)' : '';

  if (downgraded) state.texSize = downgraded;
}

function syncStatusModel() {
  $('stat-model').innerHTML = `<b>${modelName}</b> · меш: ${activeMesh?.name || '—'}`;
}
function syncPerf() {
  $('stat-perf').textContent = perfMs > 0.05 ? `кисть ${perfMs.toFixed(1)} мс/кадр` : '';
}

let hintTimer = null;
const HINT = 'ЛКМ — инструмент · ПКМ — вращать · пробел+ЛКМ — двигать · колесо — зум';
function setStatusHint(text) {
  const hint = document.querySelector('#statusbar .hint');
  clearTimeout(hintTimer);
  hint.textContent = text;
  hintTimer = setTimeout(() => { hint.textContent = HINT; }, 2500);
}

$('btn-demo').addEventListener('click', () => afterModelLoaded(viewport.loadDemo()));
$('btn-open').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await openFile(f);
  e.target.value = '';
});

async function openFile(file) {
  try {
    const buf = await file.arrayBuffer();
    afterModelLoaded(await viewport.loadGLB(buf, file.name));
  } catch (err) {
    setStatusHint('не прочиталось: ' + err.message);
    console.error(err);
  }
}

el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
el.addEventListener('dragleave', () => el.classList.remove('dragover'));
el.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f && /\.(glb|gltf)$/i.test(f.name)) await openFile(f);
});

function setTexSize(next) {
  if (next === state.texSize) return;
  if (state.painted && !confirm('Смена размера текстуры сотрёт покраску. Продолжить?')) return;
  state.texSize = next;
  const tris = $('stat-tris').textContent;
  afterModelLoaded({ name: modelName, meshes: viewport.paintables.length, tris: 0, noUV: [] });
  $('stat-tris').textContent = tris;
}

/* ── Сохранение ────────────────────────────────────────────────── */

function download(canvas, name) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

/** Есть ли на карте материала хоть что-то, кроме подложки. */
function hasMaterialPaint(t) {
  for (let p = 0; p < t.size * t.size; p++) {
    if (t.orm[p * 4 + 2] > 4 || Math.abs(t.orm[p * 4 + 1] - t.bgRough) > 3) return true;
  }
  return false;
}

function saveTextures() {
  if (!targets.size) return;
  const base = modelName.replace(/\.(glb|gltf)$/i, '') || 'model';
  let files = 0;
  let i = 0;

  for (const [mesh, t] of targets) {
    const stem = targets.size > 1 ? `${base}_${mesh.name || 'mesh' + i}` : base;
    download(t.canvas, `${stem}.png`);
    files += 1;

    // Карта материала выгружается, только если по ней действительно красили:
    // иначе она молча потерялась бы вместе со всей работой по поверхности.
    if (hasMaterialPaint(t)) {
      download(t.ormCanvas, `${stem}_material.png`);
      files += 1;
    }
    i += 1;
  }
  setStatusHint(`сохранено файлов: ${files} (цвет${files > targets.size ? ' и материал' : ''})`);
}
$('btn-save').addEventListener('click', saveTextures);

/* ── Клавиатура ────────────────────────────────────────────────── */

const TOOL_KEYS = { b: 'brush', e: 'eraser', i: 'eyedropper', f: 'fill-faces', g: 'fill-island', m: 'mask', r: 'rect', c: 'ellipse', t: 'text' };
const VIEW_KEYS = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 6: 'top', 7: 'bottom', 0: 'user' };

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  // Пробел — временный режим перемещения, как принято в графических пакетах.
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; uvEditor.spaceDown = true; viewport.setLeftButtonPan(true); }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) history.redo(); else history.undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Tab') { e.preventDefault(); toggleAllPanels(); return; }
  if (e.key === 'Home') { viewport.centerCamera(); return; }
  if (e.key === 'F1') { e.preventDefault(); helpModal.open(); return; }

  const k = e.key.toLowerCase();
  if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
  if (k === 'u') { setUVOpen(!state.uvOpen); return; }
  if (k === '5') { setProjection(viewport.projection === 'ortho' ? 'persp' : 'ortho'); return; }
  if (VIEW_KEYS[k]) { applyView(VIEW_KEYS[k]); return; }

  if (e.key === '[' || e.key === ']') {
    state.sizePct = Math.min(40, Math.max(0.3,
      +(state.sizePct * (e.key === ']' ? 1.25 : 0.8)).toFixed(2)));
    $('brush-size').value = state.sizePct;
    syncBrushLabels();
    uvEditor.draw();
  }
});

const releaseSpace = () => {
  if (!spaceDown) return;
  spaceDown = false;
  uvEditor.spaceDown = false;
  viewport.setLeftButtonPan(false);
};
window.addEventListener('keyup', (e) => { if (e.code === 'Space') releaseSpace(); });
window.addEventListener('blur', releaseSpace);

/* ── Меню программы ────────────────────────────────────────────── */

const MOD = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+';

const menuBar = new MenuBar($('menubar'), [
  { title: 'Файл', items: [
    { label: 'Открыть GLB…', action: () => $('file-input').click() },
    { label: 'Демо-модель', action: () => afterModelLoaded(viewport.loadDemo()) },
    '-',
    { label: 'Сохранить PNG', disabled: () => !targets.size, action: saveTextures },
    '-',
    { label: 'Текстура 512', radio: () => state.texSize === 512, action: () => setTexSize(512) },
    { label: 'Текстура 1024', radio: () => state.texSize === 1024, action: () => setTexSize(1024) },
    { label: 'Текстура 2048', radio: () => state.texSize === 2048, action: () => setTexSize(2048) },
  ] },

  { title: 'Правка', items: [
    { label: 'Отменить', hint: MOD + 'Z', disabled: () => !history.canUndo, action: () => history.undo() },
    { label: 'Вернуть', hint: '⇧' + MOD + 'Z', disabled: () => !history.canRedo, action: () => history.redo() },
    '-',
    { label: 'К исходному состоянию', disabled: () => !history.canUndo, action: () => history.goto(-1) },
    { label: 'К последнему шагу', disabled: () => !history.canRedo, action: () => history.goto(history.entries.length - 1) },
  ] },

  { title: 'Слой', items: [
    { label: 'Новый слой', action: addLayer },
    { label: 'Маска слоя', action: () => $('btn-layer-mask').click() },
    { label: 'Удалить слой', disabled: () => (refLayers()?.length ?? 0) <= 1, action: removeLayer },
    '-',
    { label: 'Наложение: обычное', radio: () => currentBlend() === 'normal', action: () => setBlend('normal') },
    { label: 'Наложение: умножение', radio: () => currentBlend() === 'multiply', action: () => setBlend('multiply') },
    { label: 'Наложение: экран', radio: () => currentBlend() === 'screen', action: () => setBlend('screen') },
  ] },

  { title: 'Вид', items: [
    { label: 'Спереди', hint: '1', radio: () => viewport.currentViewName() === 'front', action: () => applyView('front') },
    { label: 'Сзади', hint: '2', radio: () => viewport.currentViewName() === 'back', action: () => applyView('back') },
    { label: 'Слева', hint: '3', radio: () => viewport.currentViewName() === 'left', action: () => applyView('left') },
    { label: 'Справа', hint: '4', radio: () => viewport.currentViewName() === 'right', action: () => applyView('right') },
    { label: 'Сверху', hint: '6', radio: () => viewport.currentViewName() === 'top', action: () => applyView('top') },
    { label: 'Снизу', hint: '7', radio: () => viewport.currentViewName() === 'bottom', action: () => applyView('bottom') },
    { label: 'Три четверти', hint: '0', action: () => applyView('user') },
    '-',
    { label: 'Ортография', hint: '5', checked: () => viewport.projection === 'ortho',
      action: () => setProjection(viewport.projection === 'ortho' ? 'persp' : 'ortho') },
    { label: 'Вписать в кадр', hint: 'Home', action: () => viewport.centerCamera() },
    '-',
    { label: 'Вращать вокруг мира', radio: () => state.pivot === 'world', action: () => setPivot('world') },
    { label: 'Вращать вокруг объекта', radio: () => state.pivot === 'local', action: () => setPivot('local') },
    { label: 'Вращать вокруг точки взгляда', radio: () => state.pivot === 'camera', action: () => setPivot('camera') },
    '-',
    { label: 'Показ плоско', checked: () => state.display === 'flat',
      action: () => setDisplayMode(state.display === 'flat' ? 'material' : 'flat') },
    { label: 'Сетка пола', checked: () => state.grid, action: () => setGrid(!state.grid) },
    { label: 'Сетка модели', checked: () => state.vertices, action: () => setVertices(!state.vertices) },
  ] },

  { title: 'Инструмент', items: [
    { label: 'Кисть', hint: 'B', radio: () => state.tool === 'brush', action: () => setTool('brush') },
    { label: 'Ластик', hint: 'E', radio: () => state.tool === 'eraser', action: () => setTool('eraser') },
    { label: 'Пипетка', hint: 'I', radio: () => state.tool === 'eyedropper', action: () => setTool('eyedropper') },
    '-',
    { label: 'Заливка связанных граней', hint: 'F', radio: () => state.tool === 'fill-faces', action: () => setTool('fill-faces') },
    { label: 'Заливка UV-острова', hint: 'G', radio: () => state.tool === 'fill-island', action: () => setTool('fill-island') },
    { label: 'Залить весь слой', radio: () => state.tool === 'fill-layer', action: () => setTool('fill-layer') },
    '-',
    { label: 'Кисть по маске', hint: 'M', radio: () => state.tool === 'mask', action: () => setTool('mask') },
    '-',
    { label: 'Прямоугольник', hint: 'R', radio: () => state.tool === 'rect', action: () => setTool('rect') },
    { label: 'Круг', hint: 'C', radio: () => state.tool === 'ellipse', action: () => setTool('ellipse') },
    { label: 'Текст', hint: 'T', radio: () => state.tool === 'text', action: () => setTool('text') },
    '-',
    { label: 'Кисти…', action: () => brushModal.open() },
    { label: 'Материалы и цвет…', action: () => materialModal.open() },
  ] },

  { title: 'Панели', items: [
    { label: 'Развёртка', hint: 'U', checked: () => state.uvOpen, action: () => setUVOpen(!state.uvOpen) },
    { label: 'Сетка развёртки', checked: () => state.showWire, action: () => setShowWire(!state.showWire) },
    '-',
    { label: 'Колонка инструментов', checked: () => !app.classList.contains('no-tools'),
      action: () => togglePanel('no-tools', $('btn-tools-toggle')) },
    { label: 'Правая панель', checked: () => !app.classList.contains('no-side'),
      action: () => togglePanel('no-side', $('btn-side-toggle')) },
    { label: 'Скрыть всё', hint: 'Tab', action: toggleAllPanels },
  ] },

  { title: 'Справка', items: [
    { label: 'Клавиши и приёмы…', hint: 'F1', action: () => helpModal.open() },
  ] },
]);

/* ── Старт ─────────────────────────────────────────────────────── */

(function restoreUI() {
  const p = loadPrefs();
  if (p.sections) {
    for (const [key, open] of Object.entries(p.sections)) {
      const s = document.querySelector(`.section[data-key="${key}"]`);
      if (s) s.dataset.open = open;
    }
  }
  if (p.uvWidth) document.documentElement.style.setProperty('--uv-width', p.uvWidth.trim());
  if (p.sideWidth) document.documentElement.style.setProperty('--side-w', p.sideWidth);
  if (p['no-tools']) { app.classList.add('no-tools'); }
  if (p['no-side']) { app.classList.add('no-side'); }
  $('btn-tools-toggle').classList.toggle('on', !app.classList.contains('no-tools'));
  $('btn-side-toggle').classList.toggle('on', !app.classList.contains('no-side'));
  setUVOpen(!!p.uvOpen);
})();

setMaterial({ color: state.color, name: 'Краска' });
syncShapeUI();
setTool('brush');
setProjection('persp');
setGrid(true);
setVertices(false);
afterModelLoaded(viewport.loadDemo());
setPivot(loadPrefs().pivot || 'local');
syncViewUI();

// Доступ из консоли браузера — чтобы проверять инструмент вручную и видеть,
// куда попадает луч, не угадывая координаты по скриншоту.
window.__paint = { viewport, uvEditor, viewCube, menuBar, brushModal, materialModal, helpModal, targets, state, history, setTool, setColor, setMaterial, bootErrors };

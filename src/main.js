/**
 * Сборка инструмента: состояние, связь панелей с вьюпортом, развёрткой и
 * ядром покраски.
 */

import './style.css';
import { Viewport, ORBIT_SPEED } from './viewport.js';
import { UVEditor } from './uveditor.js';
import { ViewCube } from './viewcube.js';
import { MenuBar } from './menubar.js';
import { PaintTarget, History, bleedLayer, remapLayer, Layer } from './layers.js';
import { Stroke, rectStencil, ellipseStencil, imageStencil } from './painter.js';
import { loadDecalImage, decalStencil, DecalOverlay, quadFromDrag, hitQuad, dragQuad, quadBounds, quadInverse } from './decal.js';
import * as THREE from 'three';
import { floodFaces, OVERLAP_LIMIT } from './mesh-cache.js';
import * as UI from './ui.js';
import { createBrushModal, createMaterialModal, createHelpModal,
         createSaveAsModal, createSettingsModal, createViewPngModal, createAboutModal,
         createEffectModal } from './modals.js';
import { LEVELS_OFF } from './effects.js';
import { createMcpTools } from './mcp.js';
import значокПрограммы from './app-icon.png';
import { drawMaterialBall } from './matball.js';
import { t, setLang, getLang, onLangChange, applyDOM, LANGS } from './i18n.js';
import { acceptAttribute, isSupported, isSidecar, extensionOf, exportGLTF, exportOBJ, exportGeometryGLB } from './formats.js';
import { packProject, unpackProject, isProject, PROJECT_EXT } from './project.js';
import { version as APP_VERSION } from '../package.json';
import { createWelcome } from './welcome.js';
import { addRecent, recentId, setThumb } from './recent.js';
import { withBusy, busyNote } from './busy.js';
import { rasterPolygon, projectCover, combine, isEmpty, outline } from './selection.js';
import { initTooltips } from './tooltip.js';
import { canSaveToFolder, pickFolder, writeToFolder, downloadBlob, canvasBlob, safeName } from './savefiles.js';

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
  matName: () => t('mat.paint'),
  // Фигуры и текст: чем печатаем и какой толщины.
  shape: { outline: false, thickness: 4, text: t('shape.textDefault'), font: 96, family: 'system' },
  pivot: 'local',             // вокруг чего вращаем вид
  sizePct: 4,        // диаметр кисти в % от габарита модели
  // Кисть одним объектом: её же получают ядро покраски и окно кистей.
  brush: { hardness: 0.7, flow: 1, grain: 0, shape: 'round', spacing: 0.25, scatter: 0 },
  frontOnly: true,
  fillAngle: 40,
  // Вращение шагами: включено ли и по сколько градусов.
  orbitSnap: false,
  orbitStep: 30,
  selMode: 'new',    // как лассо складывается с выделенным: new | add | sub | and
  activeLayer: 0,
  // Варианты покраски — общие для всех мешей модели: [{id, name, auto}].
  // Пусто — вариантов нет, все слои собираются вместе, как раньше.
  variants: [],
  activeVariant: null,
  nextVariant: 1,
  texSize: 1024,
  // Размер, выбранный человеком. texSize — у текущей модели: его может
  // поднять или урезать программа, а следующая модель считается отсюда.
  texSizeBase: 1024,
  showWire: true,
  viewMode: 'material',   // показ модели: material | clay | wire | normals
  unlit: false,            // «Без света»: цвета ровно как в текстуре
  facets: false,           // «Грани»: плоские грани, как в low-poly
  light: { power: 1, angle: 0 },
  grid: true,
  uvOpen: false,
  painted: false,
};

const viewport = new Viewport($('viewport'));
const history = new History(40);

/** meshUUID -> PaintTarget. У каждого меша своя текстура: развёртки совпадают. */
const targets = new Map();
let activeMesh = null;
let modelName = '—';
let lastReport = null;   // последний отчёт о загрузке: нужен, чтобы пересобрать статистику при смене языка

const uvEditor = new UVEditor($('uv-body'), {
  currentTool: () => state.tool,
  brushRadiusScreen: () => uvBrushRadiusTexels() * uvEditor.view.scale / (activeTarget()?.size || 1024),
  onBegin: uvBegin,
  onMove: uvMove,
  onEnd: uvEnd,
  onFill: uvFill,
  onPick: uvPick,
  onShape: uvShape,
  onDecal: (phase, e, p) => decalPointer('uv', phase, e, p),
  afterDraw: () => drawDecal(),
  lassoMode,
  onLasso: (pts, mode) => {
    const target = activeTarget();
    if (!target) return;
    const S = target.size;
    const fresh = new Map([[target, rasterPolygon(pts.map((p) => ({ x: p.tx, y: p.ty })), S, S)]]);
    applySelection(fresh, mode);
  },
  onLassoClick: (mode) => { if (mode === 'new') clearSelection(); },
});

/* ── Настройки интерфейса переживают перезагрузку ──────────────── */

const PREFS = 'paint-tool.ui';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; }
}
function savePrefs(patch) {
  try { localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* приватный режим */ }
}

/* ── Масштаб интерфейса ────────────────────────────────────────── */

/** Пределы ползунка: мельче 80% текст не читается, крупнее 200% панели
    съедают вьюпорт даже на большом экране. */
const UI_MIN = 0.8, UI_MAX = 2;

function uiScale() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui'));
  return v > 0 ? v : 1;
}

/** Применить масштаб. Панели меняют ширину — холсты подстраиваются сами
    через ResizeObserver, покраска не теряется. */
function setUiScale(v, save = true) {
  const k = Math.min(UI_MAX, Math.max(UI_MIN, Math.round(v * 20) / 20));
  document.documentElement.style.setProperty('--ui', String(k));
  if (save) {
    savePrefs({ uiScale: k });
    // Превью развёртки рисуется под плотность — перерисовать по новой.
    requestAnimationFrame(() => refreshUV());
  }
  return k;
}
// Сразу, до первой отрисовки: иначе программа мелькнула бы мелкой.
setUiScale(loadPrefs().uiScale || 1, false);

/* ── Слои: структура общая для всех мешей модели ───────────────── */

function eachTarget(fn) { targets.forEach(fn); }
function activeTarget() { return activeMesh ? targets.get(activeMesh) : null; }
function refLayers() { const t = activeTarget(); return t ? t.layers : null; }

/**
 * Сколько текселей достаётся медианному треугольнику меша при стороне S.
 * Медиана, а не среднее: у персонажа крупные грани тянут среднее вверх, а
 * лесенка видна как раз на мелких (замер: среднее 91, медиана 20 при 1024).
 */
function медианаТекселей(cache, S) {
  const { uv, idx, triCount } = cache;
  if (!triCount) return Infinity;
  const площади = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    площади[t] = Math.abs((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1])
      - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
  }
  площади.sort();
  return площади[triCount >> 1] * S * S;
}

/** Меньше стольких текселей на медианный треугольник — край заливки идёт лесенкой. */
const МАЛО_ТЕКСЕЛЕЙ = 64;

function buildTargets(paintables, имя = null) {
  targets.forEach((t) => t.dispose());
  targets.clear();

  // Много мешей на крупной текстуре съедят память: 2048² × RGBA = 16 МБ на
  // слой на меш. Для уровня с десятком объектов сбрасываем размер сами.
  let size = state.texSizeManualFor === имя ? state.texSize : state.texSizeBase;
  let downgraded = false;
  let upgraded = false;
  if (paintables.length > 8 && size > 512) { size = 512; downgraded = true; }
  // Плотная модель на мелкой текстуре: треугольнику достаётся пятно в
  // несколько пикселей, и край любой заливки вблизи идёт лесенкой (у
  // персонажа в 6953 трис — 20 текселей на медианный треугольник при 1024).
  // Берём 2048 сами — если человек не выбрал размер для этой модели руками.
  else if (size < 2048 && paintables.length && state.texSizeManualFor !== имя
    && paintables.some(({ cache }) => медианаТекселей(cache, size) < МАЛО_ТЕКСЕЛЕЙ)) {
    size = 2048;
    upgraded = true;
  }

  for (const { mesh } of paintables) {
    const t = new PaintTarget(size);
    targets.set(mesh, t);
    viewport.applyPaintMaterial(mesh, t);
  }

  state.activeLayer = 0;
  state.variants = []; state.activeVariant = null; state.nextVariant = 1;
  activeMesh = paintables.length ? paintables[0].mesh : null;
  // Выделение жило у прежних целей и ушло вместе с ними.
  uvEditor.setSelectionOutline(null);
  history.clear();
  state.painted = false;
  return { size, downgraded, upgraded };
}

/**
 * Выпечь цвета материалов из файла в первый слой.
 *
 * Модель из интернета приходит раскрашенной материалами, а не текстурой:
 * в .mtl лежат плоские Kd. Показать их нечем — мы кладём на меш свою
 * текстуру, — поэтому цвета переносятся в покраску. Заодно они становятся
 * правимыми: это ровно то, ради чего инструмент и нужен.
 *
 * В журнал не пишем: это не действие человека, а состояние, с которого он
 * начинает. `buildTargets` историю уже очистил.
 *
 * @returns {number} сколько цветов перенесено
 */
function bakeSourceColors(paintables) {
  let перенесено = 0;
  for (const { mesh, cache } of paintables) {
    const groups = mesh.userData.sourceGroups;
    const target = targets.get(mesh);
    if (!groups?.length || !target) continue;
    target.activeIndex = 0;
    for (const g of groups) {
      const набор = new Set();
      for (let t = g.from; t < g.to; t++) набор.add(t);
      if (!набор.size) continue;
      const s = new Stroke(target, cache, {
        channel: 'rgba', mode: 'paint', color: g.rgb, color2: g.rgb,
        opacity: 1, alpha: 1, roughness: 0.9, metalness: 0, pattern: { id: 'none' },
      });
      s.fillTriangles(набор);
      s.flush();
      s.end(toolLabel());
      перенесено += 1;
    }
    // Промежутки между островами получают цвет ближайшего острова. Иначе
    // видеокарта подмешивает в края швов некрашеную подложку, и вдоль них
    // ползёт серая кайма; в редакторе развёртки та же пустота читается
    // серым прямоугольником вокруг кисти.
    if (groups.length) {
      bleedLayer(target.layers[0], target.size);
      target.compositeRect(null);
      target.updateTransparency?.();
    }
  }
  return перенесено;
}

/**
 * Перенести готовые карты из файла в первый слой: модель, сохранённая с
 * покраской, открывается с ней же, и её можно красить дальше.
 *
 * Карта кладётся по текселям целиком — это та же развёртка, что у файла.
 *   цвет        → цвет слоя, альфа карты → прозрачность материала (так её
 *                 и пишет наша выгрузка);
 *   карта ORM   → шероховатость из зелёного канала, металл из синего.
 *
 * Ориентация: наш холст покраски лежит строками сверху вниз, как текстура с
 * flipY. Картинки glTF приходят без flipY — их переворачиваем.
 *
 * @returns {number} на скольких мешах карта легла
 */
function bakeSourceMaps(paintables) {
  let легло = 0;
  for (const { mesh } of paintables) {
    const карты = mesh.userData.sourceMaps;
    const target = targets.get(mesh);
    if (!карты?.color || !target) continue;
    if (!картаВСлой(target.layers[0], карты, target.size)) continue;
    target.compositeRect(null);
    target.updateTransparency?.();
    легло += 1;
  }
  if (легло) viewport.syncTransparency();
  return легло;
}

/** Карты из файла — в слой целиком. @returns {boolean} легла ли карта цвета */
function картаВСлой(L, карты, S) {
  const цвет = пикселиКарты(карты.color, S);
  if (!цвет) return false;
  for (let p = 0; p < S * S; p++) {
    const o = p * 4;
    L.rgba[o] = цвет[o]; L.rgba[o + 1] = цвет[o + 1]; L.rgba[o + 2] = цвет[o + 2];
    L.rgba[o + 3] = 255;
    L.opac[p] = цвет[o + 3];
  }
  const орм = карты.orm && пикселиКарты(карты.orm, S);
  if (орм) {
    for (let p = 0; p < S * S; p++) { L.rough[p] = орм[p * 4 + 1]; L.metal[p] = орм[p * 4 + 2]; }
  }
  return true;
}

/**
 * Варианты покраски из GLB (`KHR_materials_variants`) — обратно вариантами:
 * карта каждого ложится единственным слоем своего варианта. Общих слоёв в
 * файле нет — там уже сведённые картинки, — поэтому вариант приходит целиком.
 *
 * @returns {number} сколько вариантов вернулось
 */
function bakeSourceVariants(paintables, имена) {
  if (!имена || имена.length < 2) return 0;
  const сКартами = paintables.filter(({ mesh }) => mesh.userData.sourceVariantMaps && targets.get(mesh));
  if (!сКартами.length) return 0;
  state.variants = имена.map((name, i) => ({ id: i + 1, name, auto: null }));
  state.nextVariant = имена.length + 1;
  // Включён тот, что был включён при сохранении: его материал — по умолчанию.
  const поУмолчанию = Math.max(0, сКартами[0].mesh.userData.defaultVariant ?? 0);
  for (const { mesh } of сКартами) {
    const target = targets.get(mesh);
    const S = target.size;
    target.layers = имена.map((_, i) => {
      const L = new Layer(S, null, i + 1);
      L.variant = i + 1;
      const карты = mesh.userData.sourceVariantMaps[i];
      if (карты?.color) картаВСлой(L, карты, S);
      return L;
    });
  }
  // Меши без вариантов держат один общий слой — у всех целей слоёв должно
  // быть поровну (номер слоя общий на модель), добиваем пустыми.
  for (const [mesh, target] of targets) {
    if (сКартами.some((p) => p.mesh === mesh)) continue;
    while (target.layers.length < имена.length) target.layers.push(new Layer(target.size, null, target.layers.length + 1));
  }
  включитьВариант(поУмолчанию + 1, { тихо: true });
  return имена.length;
}

/** Картинку текстуры — в пиксели S×S, в ориентации холста покраски. */
function пикселиКарты(карта, S) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    if (!карта.flipY) { g.translate(0, S); g.scale(1, -1); }
    g.drawImage(карта.image, 0, 0, S, S);
    return g.getImageData(0, 0, S, S).data;
  } catch (err) {
    console.warn('[3DPainter] карта из файла не прочиталась:', err);
    return null;
  }
}

/** @param {string} [name] своё имя; без него — номером. Кнопка передаёт событие — его не берём. */
function addLayer(name) {
  const имя = typeof name === 'string' && name.trim() ? name.trim() : null;
  // Новый слой — той же принадлежности, что активный: в варианте рядом со
  // слоем варианта — тоже его, рядом с общим — общий.
  const вариант = refLayers()?.[state.activeLayer]?.variant ?? null;
  eachTarget((t) => { t.activeIndex = state.activeLayer; t.addLayer(имя, вариант); });
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
  history.prune((e) => !(e.group || [e]).some((x) => doomed.has(x.layer)));

  eachTarget((t) => t.removeLayer(state.activeLayer));
  state.activeLayer = Math.min(state.activeLayer, first.layers.length - 1);
  поправитьАктивныйСлой();
  syncLayers();
  refreshUV();
}

function setActiveLayer(i) {
  state.activeLayer = i;
  eachTarget((t) => { t.activeIndex = i; });
  syncLayers();
}

/* ── Варианты покраски ─────────────────────────────────────────── */

/*
 * Вариант — обличье модели на той же развёртке: разные лица Kian, разные
 * сундуки. Слой либо общий (виден во всех вариантах), либо принадлежит
 * одному варианту. Включён всегда один вариант; в GLB каждый уходит своим
 * материалом (`KHR_materials_variants`), в Blender они переключаются в
 * панели glTF Variants.
 */

function имяВарианта(v) { return v.auto ? t('variants.name', v.auto) : v.name; }
function слойВВарианте(L) { return L.variant == null || L.variant === state.activeVariant; }

/** Активный слой должен быть виден в варианте — иначе мазок ушёл бы в невидимое. */
function поправитьАктивныйСлой() {
  const L = refLayers();
  if (!L || (L[state.activeLayer] && слойВВарианте(L[state.activeLayer]))) return;
  for (let i = L.length - 1; i >= 0; i--) {
    if (слойВВарианте(L[i])) { state.activeLayer = i; eachTarget((t) => { t.activeIndex = i; }); return; }
  }
}

function включитьВариант(id, { тихо = false } = {}) {
  state.activeVariant = id;
  eachTarget((t) => { t.variant = id; t.compositeRect(null); });
  // Включили вариант — значит, будут красить его: активным становится его
  // верхний собственный слой, а не общий, оставшийся от прежнего варианта.
  const L = refLayers() || [];
  let свой = -1;
  for (let i = L.length - 1; i >= 0 && свой < 0; i--) if (L[i].variant === id) свой = i;
  if (свой >= 0) { state.activeLayer = свой; eachTarget((t) => { t.activeIndex = свой; }); }
  поправитьАктивныйСлой();
  if (тихо) return;
  viewport.syncTransparency();
  syncLayers(); syncVariants(); drawUVRows(); refreshUV();
}

/**
 * Добавить вариант со своим пустым слоем сверху. Первый «+» заводит сразу
 * два: всё, что уже покрашено, остаётся общим, а новый вариант — второй.
 */
function addVariant() {
  if (!targets.size) return;
  if (!state.variants.length) state.variants.push({ id: state.nextVariant++, name: null, auto: 1 });
  const v = { id: state.nextVariant++, name: null, auto: state.variants.length + 1 };
  state.variants.push(v);
  включитьВариант(v.id, { тихо: true });
  const наверх = refLayers().length - 1;
  eachTarget((t) => { t.activeIndex = наверх; t.addLayer(null, v.id); });
  state.activeLayer = наверх + 1;
  viewport.syncTransparency();
  syncLayers(); syncVariants(); drawUVRows(); refreshUV();
  setStatusHint(t('variants.created', имяВарианта(v)));
}

function renameVariant(id) {
  const v = state.variants.find((x) => x.id === id);
  if (!v) return;
  const имя = prompt(t('variants.renamePrompt'), имяВарианта(v));
  if (!имя || !имя.trim()) return;
  v.name = имя.trim(); v.auto = null;
  syncVariants(); syncLayers();
}

/** Удалить вариант вместе с его слоями. Последний не удаляется. */
function removeVariant(id) {
  const v = state.variants.find((x) => x.id === id);
  if (!v || state.variants.length <= 1) return;
  const свои = refLayers().filter((L) => L.variant === id).length;
  if (!confirm(t('variants.confirmDelete', имяВарианта(v), свои))) return;

  // Записи журнала держат ссылку на слой — см. removeLayer.
  const doomed = new Set();
  eachTarget((tg) => tg.layers.forEach((L) => { if (L.variant === id) doomed.add(L); }));
  history.prune((e) => !(e.group || [e]).some((x) => doomed.has(x.layer)));
  eachTarget((tg) => {
    tg.layers = tg.layers.filter((L) => L.variant !== id);
    if (!tg.layers.length) tg.layers.push(new Layer(tg.size, null, 1));
  });
  state.variants = state.variants.filter((x) => x.id !== id);
  state.activeLayer = Math.min(state.activeLayer, refLayers().length - 1);
  eachTarget((tg) => { tg.activeIndex = state.activeLayer; });
  включитьВариант(state.activeVariant === id ? state.variants[0].id : state.activeVariant);
}

/** Слой общий ↔ только в включённом варианте. */
function toggleLayerVariant(i) {
  const L = refLayers()?.[i];
  if (!L || state.activeVariant == null) return;
  const вариант = L.variant == null ? state.activeVariant : null;
  eachTarget((tg) => { tg.layers[i].variant = вариант; tg.compositeRect(null); });
  viewport.syncTransparency();
  syncLayers(); drawUVRows(); refreshUV();
}

/** Ряд вариантов под заголовком «Развёртка»: щелчок — включить, двойной — имя. */
function syncVariants() {
  const box = $('variant-row');
  box.textContent = '';
  box.hidden = !state.variants.length;
  for (const v of state.variants) {
    const чип = элемент('button', 'variant-chip' + (v.id === state.activeVariant ? ' on' : ''));
    чип.append(элемент('span', 'variant-name', имяВарианта(v)));
    чип.title = t('variants.chipTip');
    чип.addEventListener('click', () => { if (v.id !== state.activeVariant) включитьВариант(v.id); });
    чип.addEventListener('dblclick', (e) => { e.preventDefault(); renameVariant(v.id); });
    if (state.variants.length > 1) {
      const крест = элемент('span', 'variant-del', '×');
      крест.title = t('variants.delete');
      крест.addEventListener('click', (e) => { e.stopPropagation(); removeVariant(v.id); });
      чип.append(крест);
    }
    box.appendChild(чип);
  }
}
$('btn-variant-add').addEventListener('click', addVariant);

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

function strokeOpts() {
  return {
    channel: 'rgba',
    mode: state.tool === 'eraser' ? 'erase' : 'paint',
    color: state.color,
    // 🔴 Два разных понятия, и путать их нельзя:
    //   opacity — укрывистость мазка. Сила мазка живёт в кисти («Нажим»),
    //             у материала её нет, поэтому здесь всегда 1.
    //   alpha   — прозрачность самого материала, то самое стекло. Уходит
    //             в карту прозрачности и ничего не решает про укрывистость.
    // Когда оба звались opacity, второй ключ молча затирал первый: краска
    // с «Прозрачностью 50%» ложилась вполсилы и мешалась с подложкой
    // (замер: синий по красному давал 130,65,135 вместо 40,90,230), а само
    // стекло выходило вдвое слабее заказанного — 191 вместо 128.
    opacity: 1,
    alpha: state.opacity,
    roughness: state.roughness,
    metalness: state.metalness,
    pattern: state.pattern,
    color2: state.color2,
    texture: state.texture,
  };
}

/**
 * Ключ названия действия — не готовая строка: шаг истории живёт дольше,
 * чем выбранный язык, и переводится при каждой отрисовке списка.
 */
function toolLabel() {
  return { brush: 'act.brush', eraser: 'act.eraser',
           'fill-faces': 'act.fillFaces', 'fill-island': 'act.fillIsland',
           'fill-layer': 'act.fillLayer',
           rect: 'act.rect', ellipse: 'act.ellipse', text: 'act.text',
           decal: 'act.decal' }[state.tool] || 'act.edit';
}

const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'text']);

/**
 * Покраска легла, а на модели её не видно: в «Глине» и «Нормалях» модель
 * рисуется своим материалом, без карты. Владелец красил в «Глине», видел
 * краску в развёртке и белую модель — и решил, что покраска не применяется.
 * Подсказка — после правки, не запрет: форму в «Глине» смотрят нарочно.
 */
function warnHiddenPaint() {
  const m = state.viewMode;
  if (m !== 'clay' && m !== 'normals') return;
  setStatusHint(t('status.hiddenPaint', t('vm.' + m), t('vm.material')));
}

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
    if (state.uvOpen) uvEditor.drawTexelRect(stroke.lastApplied);
    // Превью — целая текстура в маленький квадрат; каждый кадр ни к чему.
    if ((pumpFrame++ % 6) === 0) {
      drawUVRow(activeMesh);
    }
    syncPerf();
  }
  pumpId = requestAnimationFrame(pump);
}
function startPump() { if (!pumpId) pumpId = requestAnimationFrame(pump); }

function beginStroke(target, cache, mesh, shift) {
  target.activeIndex = state.activeLayer;
  stroke = new Stroke(target, cache, strokeOpts());
  strokeMesh = mesh;
  lastScreen = null;
  lastTexel = null;
  startPump();
}

function endStroke() {
  if (!stroke) return;
  const entry = stroke.end(toolLabel());
  if (entry) history.push(entry);
  if (entry) warnHiddenPaint();
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

/**
 * Напечатать фигуру или надпись прямо по развёртке.
 *
 * На модели трафарет кладётся проекцией на экран — там иначе нельзя, грань
 * повёрнута. Здесь развёртка и есть плоскость текстуры, поэтому тот же
 * трафарет считается прямо в текселях, без проекции.
 */
function uvShape(a, b, shift) {
  const target = activeTarget();
  const cache = activeMesh?.userData.paintCache;
  if (!target || !cache) return;
  target.activeIndex = state.activeLayer;

  let ax = a.tx, ay = a.ty, bx = b.tx, by = b.ty;

  // Shift равняет стороны — квадрат и правильный круг, как и на модели.
  if (shift && state.tool !== 'text') {
    const d = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    bx = ax + Math.sign(bx - ax || 1) * d;
    by = ay + Math.sign(by - ay || 1) * d;
  }

  const st = shapeStencil(state.tool, { x: ax, y: ay }, { x: bx, y: by });
  const fn = st.fn || st;

  // Область печати: рамка с запасом на толщину контура, у надписи — её
  // собственный размер. Без запаса контур срезало бы по краю рамки.
  const пад = Math.ceil((state.shape.thickness || 1) + 2);
  const box = st.img
    ? { x0: ax - st.img.w / 2, y0: ay - st.img.h / 2, x1: ax + st.img.w / 2, y1: ay + st.img.h / 2 }
    : { x0: Math.min(ax, bx) - пад, y0: Math.min(ay, by) - пад,
        x1: Math.max(ax, bx) + пад, y1: Math.max(ay, by) + пад };

  const s = new Stroke(target, cache, strokeOpts());
  s.stampStencil2D(fn, box, state.brush);

  const entry = s.end(toolLabel());
  if (entry) history.push(entry);
  if (entry) warnHiddenPaint();
  state.painted = true;

  renderHistory();
  syncHistoryButtons();
  refreshUV();
}

function uvFill(tri) {
  const target = activeTarget();
  if (!target || !activeMesh) return;
  const cache = activeMesh.userData.paintCache;
  if (tri < 0 && state.tool !== 'fill-layer') { setStatusHint(t('status.missedUV')); return; }
  runFill(target, cache, tri);
}

function uvPick(tx, ty) {
  const target = activeTarget();
  if (!target) return;
  const S = target.size;
  // Пипетка берёт материал целиком: цвет и поверхность под ним.
  setMaterial({ ...target.sampleMaterialUV(tx / S, 1 - ty / S), name: () => t('mat.fromModel') });
}

/* Заливки ---------------------------------------------------------- */

function runFill(target, cache, faceIndex) {
  target.activeIndex = state.activeLayer;
  const s = new Stroke(target, cache, strokeOpts());

  if (state.tool === 'fill-layer') {
    s.fillAll();
  } else {
    const island = state.tool === 'fill-island';
    const set = floodFaces(cache, faceIndex,
      island ? 180 : state.fillAngle, island ? 'uv' : 'geom');
    s.fillTriangles(set);
    setStatusHint(t('status.filled', set.size));
  }

  const entry = s.end(toolLabel());
  if (entry) history.push(entry);
  if (entry) warnHiddenPaint();
  state.painted = true;
  viewport.syncTransparency();
  refreshUV();
}

/* ── Фигуры и текст ────────────────────────────────────────────── */

/** Картинка с надписью — из неё получается трафарет для печати текста. */
/**
 * Шрифты для надписей. Только те, что есть в системе без загрузки: надпись
 * печатается в текстуру сразу, и ждать веб-шрифт посреди мазка нечем.
 * Первый — системный, дальше по характеру: гротеск, антиква, машинопись,
 * плакат.
 */
const FONTS = [
  { name: 'system', key: 'font.system', css: '-apple-system, "SF Pro Text", system-ui, sans-serif' },
  { name: 'Helvetica', css: 'Helvetica, Arial, sans-serif' },
  { name: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
  { name: 'Trebuchet', css: '"Trebuchet MS", sans-serif' },
  { name: 'Georgia', css: 'Georgia, serif' },
  { name: 'Times', css: '"Times New Roman", Times, serif' },
  { name: 'Courier', css: '"Courier New", Courier, monospace' },
  { name: 'Impact', css: 'Impact, Haettenschweiler, sans-serif' },
];

function renderText(text, fontPx) {
  const pad = Math.ceil(fontPx * 0.25);
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const семейство = (FONTS.find((f) => f.name === state.shape.family) || FONTS[0]).css;
  const font = `700 ${fontPx}px ${семейство}`;

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
  const img = renderText(text || t('shape.textDefault'), px);
  return { fn: imageStencil(img.data, img.w, img.h, a.x - img.w / 2, a.y - img.h / 2), img };
}

/**
 * Матрица «локальные координаты меша → экран» и направление взгляда в осях
 * меша — по нему отбрасываются отвёрнутые грани.
 */
function projectionFor(mesh) {
  const cam = viewport.camera;
  cam.updateMatrixWorld();
  mesh.updateMatrixWorld();
  const mvp = new THREE.Matrix4()
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    .multiply(mesh.matrixWorld);
  const inv = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
  const viewDir = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(cam.quaternion).applyMatrix3(inv).normalize();
  return { mvp, viewDir };
}

/** Напечатать фигуру по поверхности — через проекцию на экран. */
function applyShape3D(mesh, a, b) {
  const target = targets.get(mesh);
  const cache = mesh.userData.paintCache;
  if (!target || !cache) return;
  target.activeIndex = state.activeLayer;

  const canvas = viewport.renderer.domElement;
  const { mvp, viewDir } = projectionFor(mesh);

  const st = shapeStencil(state.tool, a, b);
  const fn = st.fn || st;

  // Рамка на экране — с запасом на контур; у надписи — её картинка.
  const пад = Math.ceil((state.shape.thickness || 1) + 2);
  const clip = st.img
    ? { x0: a.x - st.img.w / 2, y0: a.y - st.img.h / 2, x1: a.x + st.img.w / 2, y1: a.y + st.img.h / 2 }
    : { x0: Math.min(a.x, b.x) - пад, y0: Math.min(a.y, b.y) - пад,
        x1: Math.max(a.x, b.x) + пад, y1: Math.max(a.y, b.y) + пад };
  const dep = viewport.depthSnapshot();

  const s = new Stroke(target, cache, strokeOpts());
  s.stampProjected(mvp.elements, canvas.clientWidth, canvas.clientHeight,
                   fn, viewDir, state.brush, state.frontOnly,
                   { clip, depth: dep && { ...dep, mv: dep.mvFor(mesh) } });

  const entry = s.end(toolLabel());
  if (entry) history.push(entry);
  if (entry) warnHiddenPaint();
  else setStatusHint(t('status.shapeMissed'));
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

/* ── Вращение шагами ───────────────────────────────────────────── */

/**
 * Вращать только целыми шагами по state.orbitStep градусов.
 *
 * Протяжка копится в градусах отдельно по горизонтали и вертикали; как
 * только набралось на шаг — вид доворачивается ровно на шаг, остаток ждёт
 * следующего. Шаг считается от положения на начало жеста: «повернуть на 30°»
 * значит на 30° от того, как стояло.
 */
function orbitSnapped(dx, dy) {
  const градусНаПиксель = (ORBIT_SPEED * 180) / Math.PI;
  const шаг = state.orbitStep;
  navDrag.yaw += dx * градусНаПиксель;
  navDrag.pitch += dy * градусНаПиксель;
  const nYaw = Math.trunc(navDrag.yaw / шаг);
  const nPitch = Math.trunc(navDrag.pitch / шаг);
  if (!nYaw && !nPitch) return;
  navDrag.yaw -= nYaw * шаг;
  navDrag.pitch -= nPitch * шаг;
  // Обратно в пиксели — так поворот идёт тем же путём, что и обычный, с
  // той же точкой вращения и защитой от переваливания через полюс.
  viewport.orbitBy((nYaw * шаг) / градусНаПиксель, (nPitch * шаг) / градусНаПиксель);
  navDrag.turnedYaw += nYaw * шаг;
  navDrag.turnedPitch += nPitch * шаг;
  setStatusHint(t('status.orbitTurned', navDrag.turnedYaw, navDrag.turnedPitch));
}

function syncOrbitUI() {
  $('orbit-snap').checked = state.orbitSnap;
  $('orbit-step').value = state.orbitStep;
  $('orbit-step-num').value = state.orbitStep;
  $('orbit-snap').closest('.opt-group').classList.toggle('snap-off', !state.orbitSnap);
}
function setOrbitStep(v) {
  const k = Math.round(+v);
  if (!(k >= 1)) return;                       // пустое поле, пока печатают
  state.orbitStep = Math.min(90, k);
  savePrefs({ orbitStep: state.orbitStep });
  syncOrbitUI();
}
$('orbit-snap').addEventListener('change', (e) => {
  state.orbitSnap = e.target.checked;
  savePrefs({ orbitSnap: state.orbitSnap });
  syncOrbitUI();
});
$('orbit-step').addEventListener('input', (e) => setOrbitStep(e.target.value));
$('orbit-step-num').addEventListener('change', (e) => setOrbitStep(e.target.value));
$('orbit-step-num').addEventListener('input', (e) => {
  // Число меняет шаг сразу, но недописанное поле не трогаем.
  const v = +e.target.value;
  if (v >= 1 && v <= 90) { state.orbitStep = Math.round(v); $('orbit-step').value = state.orbitStep; savePrefs({ orbitStep: state.orbitStep }); }
});
$('orbit-reset').addEventListener('click', () => { viewport.resetView(); syncViewUI(); });
{
  const p = loadPrefs();
  if (typeof p.orbitSnap === 'boolean') state.orbitSnap = p.orbitSnap;
  if (p.orbitStep >= 1 && p.orbitStep <= 90) state.orbitStep = p.orbitStep;
  syncOrbitUI();
}

/* ── Выделение ─────────────────────────────────────────────────── */

/**
 * Режим сложения для нового контура. Модификаторы на первом нажатии — как в
 * Photoshop: Shift добавляет, Alt вычитает, оба вместе — пересечение. Без них
 * действует режим из полосы параметров.
 */
function lassoMode(e) {
  if (e.shiftKey && e.altKey) return 'and';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'sub';
  return state.selMode;
}

function hasSelection() {
  for (const tg of targets.values()) if (tg.selection) return true;
  return false;
}

/**
 * Сложить новый контур с выделенным.
 *
 * Выделение одно на всю модель, но хранится по мешу. Пока оно есть, маска
 * есть у КАЖДОГО меша, пусть и пустая: меш без маски красился бы целиком, а
 * лассо, обведённое по другому объекту, его не задевало.
 *
 * @param {Map<PaintTarget, Uint8Array|null>} fresh новый контур по мешам;
 *        меша нет в списке — контур его не задел
 */
function applySelection(fresh, mode) {
  const had = hasSelection();
  let any = false;
  targets.forEach((tg) => {
    tg.selection = combine(had ? tg.selection : null, fresh.get(tg) || null, mode);
    if (tg.selection && isEmpty(tg.selection)) tg.selection = null;
    if (tg.selection) any = true;
  });
  if (any) {
    targets.forEach((tg) => { if (!tg.selection) tg.selection = new Uint8Array(tg.size * tg.size); });
  }
  selectionChanged();
}

function clearSelection() {
  if (!hasSelection()) return;
  targets.forEach((tg) => { tg.selection = null; });
  selectionChanged();
}

function selectAll() {
  targets.forEach((tg) => { tg.selection = new Uint8Array(tg.size * tg.size).fill(255); });
  selectionChanged();
}

function invertSelection() {
  if (!hasSelection()) return;
  targets.forEach((tg) => {
    const s = tg.selection;
    for (let i = 0; i < s.length; i++) s[i] = 255 - s[i];
  });
  let any = false;
  targets.forEach((tg) => { if (!isEmpty(tg.selection)) any = true; });
  if (!any) targets.forEach((tg) => { tg.selection = null; });
  selectionChanged();
}

/** Показать выделение везде, где оно видно: на модели, в развёртке, в строке. */
function selectionChanged() {
  for (const [mesh, tg] of targets) viewport.setSelection(mesh, tg.selection, tg.size);
  syncSelectionOutline();
  $('sel-clear').disabled = !hasSelection();
  setStatusHint(t(hasSelection() ? 'status.selOn' : 'status.selOff'));
}

function syncSelectionOutline() {
  const tg = activeTarget();
  uvEditor.setSelectionOutline(tg && tg.selection ? outline(tg.selection, tg.size) : null);
}

/**
 * Лассо на модели: контур лежит на экране, и каждый тексель каждого меша
 * спрашивает, куда он проецируется. Тот же путь, что у фигур.
 */
function selectFromScreen(pts, mode) {
  const canvas = viewport.renderer.domElement;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const дело = () => {
    const cover = rasterPolygon(pts, W, H);
    const cam = viewport.camera;
    cam.updateMatrixWorld();
    const fresh = new Map();
    for (const { mesh } of viewport.paintables) {
      const tg = targets.get(mesh);
      const cache = mesh.userData.paintCache;
      if (!tg || !cache) continue;
      mesh.updateMatrixWorld();
      const mvp = new THREE.Matrix4()
        .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
        .multiply(mesh.matrixWorld);
      const inv = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
      const viewDir = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(cam.quaternion).applyMatrix3(inv).normalize();
      const sel = projectCover(cache, tg.size, mvp.elements, W, H, cover, viewDir, state.frontOnly);
      if (sel) fresh.set(tg, sel);
    }
    applySelection(fresh, mode);
  };

  // Работа — обход текселей всех мешей. На одной текстуре 1024 это около
  // 60 мс: индикатор на такой срок только мигает тёмной пеленой на весь
  // экран (замер: 58 мс работы против 260 мс пелены с ожиданием кадра и
  // угасанием). Показываем его, лишь когда текселей вдвое больше и счёт
  // пойдёт на сотни миллисекунд.
  let текселей = 0;
  targets.forEach((tg) => { текселей += tg.size * tg.size; });
  if (текселей <= 2 * 1024 * 1024) { дело(); return; }
  return withBusy('busy.select', дело);
}

/* Контур лассо поверх вьюпорта — SVG: линия не должна зависеть от сцены. */
const lassoSvg = $('lasso-preview');
let lasso = null;   // { pts, mode, poly, hover, at, far, sx, sy } — в пикселях холста

function drawLassoPreview() {
  if (!lasso) { lassoSvg.classList.remove('on'); return; }
  const pts = lasso.poly && lasso.hover ? [...lasso.pts, lasso.hover] : lasso.pts;
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ')
          + (lasso.poly ? '' : ' Z');
  lassoSvg.querySelectorAll('path').forEach((pth) => pth.setAttribute('d', d));
  const f = lasso.pts[0];
  const start = lassoSvg.querySelector('rect');
  start.style.display = lasso.poly ? '' : 'none';
  start.setAttribute('x', f.x - 3.5); start.setAttribute('y', f.y - 3.5);
  lassoSvg.classList.add('on');
}

function closeLasso() {
  const l = lasso;
  lasso = null;
  drawLassoPreview();
  if (l && l.pts.length >= 3) selectFromScreen(l.pts, l.mode);
}

function cancelLasso() {
  const had = !!lasso || uvEditor.cancelLasso();
  lasso = null;
  drawLassoPreview();
  return had;
}

/** Точка лассо в координатах холста вьюпорта. */
function lassoPoint(e) {
  const r = viewport.renderer.domElement.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function lassoDown(e) {
  const p = lassoPoint(e);
  if (state.tool === 'lasso') {
    lasso = { pts: [p], mode: lassoMode(e), poly: false, far: false, sx: p.x, sy: p.y };
  } else if (!lasso) {
    lasso = { pts: [p], mode: lassoMode(e), poly: true, hover: p, at: performance.now() };
  } else {
    // Щелчок по началу или двойной щелчок замыкают контур.
    const now = performance.now();
    const f = lasso.pts[0], last = lasso.pts[lasso.pts.length - 1];
    const nearFirst = lasso.pts.length >= 3 && Math.hypot(p.x - f.x, p.y - f.y) <= 8;
    const dbl = now - lasso.at < 350 && Math.hypot(p.x - last.x, p.y - last.y) <= 5;
    if (nearFirst || dbl) { closeLasso(); return; }
    lasso.pts.push(p);
    lasso.at = now;
  }
  drawLassoPreview();
}

function lassoMove(e) {
  const p = lassoPoint(e);
  if (lasso.poly) {
    lasso.hover = p;
  } else {
    const last = lasso.pts[lasso.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) lasso.pts.push(p);
    if (Math.hypot(p.x - lasso.sx, p.y - lasso.sy) > 3) lasso.far = true;
  }
  drawLassoPreview();
}

function lassoUp() {
  if (!lasso || lasso.poly) return;
  // Щелчок без протяжки снимает выделение, как в Photoshop.
  if (!lasso.far || lasso.pts.length < 3) {
    const mode = lasso.mode;
    lasso = null;
    drawLassoPreview();
    if (mode === 'new') clearSelection();
    return;
  }
  closeLasso();
}

/** Enter, Esc и Backspace для лассо по точкам — в той панели, где его ведут. */
function lassoKey(key) {
  if (uvEditor.lassoKey(key)) return true;
  if (!lasso || !lasso.poly) return false;
  if (key === 'Escape') return cancelLasso();
  if (key === 'Enter') { closeLasso(); return true; }
  if (key === 'Backspace') {
    lasso.pts.pop();
    if (!lasso.pts.length) lasso = null;
    drawLassoPreview();
    return true;
  }
  return false;
}

function syncSelModeUI() {
  document.querySelectorAll('#sel-modes .btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.selMode));
}
document.querySelectorAll('#sel-modes .btn').forEach((b) => {
  b.addEventListener('click', () => { state.selMode = b.dataset.mode; syncSelModeUI(); });
});
$('sel-clear').addEventListener('click', clearSelection);

/* ── Ввод во вьюпорте ──────────────────────────────────────────── */

const el = $('viewport');
let spaceDown = false;
let navDrag = null;   // жест вращения или приближения левой кнопкой
let shapeDrag = null;

// Перехват в фазе погружения: иначе орбита успевает схватить нажатие раньше
// нас и модель уезжает вместо мазка.
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;      // вращение и сдвиг — не наше дело
  if (spaceDown) return;           // пробел + ЛКМ — перемещение
  // Сдвигом занимается OrbitControls, ему мешать нечем. Вращение и
  // приближение начинаем здесь — и до проверки попадания в модель: вид
  // крутят и за её пределами, по пустому кадру.
  if (state.tool === 'pan') return;
  if (VIEW_TOOLS.has(state.tool)) {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* не беда */ }
    navDrag = { kind: state.tool, x: e.clientX, y: e.clientY, yaw: 0, pitch: 0, turnedYaw: 0, turnedPitch: 0 };
    if (state.tool === 'orbit') viewport.beginNav();
    return;
  }
  // Оверлей вида лежит внутри вьюпорта, а перехват у нас в фазе погружения:
  // без этой проверки щелчок по кнопке вида заодно ставил бы мазок.
  if (inside($('view-overlay'), e.target)) return;
  // Аппликацию ставят и правят по всему кадру: углы часто уходят за модель.
  if (state.tool === 'decal') {
    e.stopPropagation();
    e.preventDefault();
    try { viewport.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* не беда */ }
    decalPointer('view', 'down', e);
    return;
  }
  // Лассо ведут и по пустому кадру: контур часто начинают мимо модели.
  if (LASSO_TOOLS.has(state.tool)) {
    e.stopPropagation();
    e.preventDefault();
    try { viewport.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* не беда */ }
    lassoDown(e);
    return;
  }
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
    // Выбор объекта ничего не красит: меш уже стал активным выше, а вместе с
    // ним — его развёртка. На составной модели это единственный способ
    // переключиться между картами, не ставя мазка.
    case 'select':
      break;

    case 'eyedropper': {
      // 🔴 Цель нельзя звать `t`: это затенило бы функцию перевода, и замыкание
      // с именем материала падало бы при каждой отрисовке подписи.
      const цель = targets.get(hit.mesh);
      if (цель && hit.uv) {
        setMaterial({ ...цель.sampleMaterialUV(hit.uv.x, hit.uv.y), name: () => t('mat.fromModel') });
      }
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
  if (lasso && (over || !lasso.poly)) { lassoMove(e); return; }
  if (state.tool === 'decal' && (over || decal.drag)) {
    viewport.hideCursor();
    if (decal.drag?.pane === 'uv') return;
    decalPointer('view', 'move', e);
    return;
  }
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

  if (navDrag) {
    const dx = e.clientX - navDrag.x, dy = e.clientY - navDrag.y;
    navDrag.x = e.clientX; navDrag.y = e.clientY;
    if (navDrag.kind === 'orbit') {
      if (state.orbitSnap) orbitSnapped(dx, dy);
      else viewport.orbitBy(dx, dy);
    } else {
      // Вверх — ближе, вниз — дальше, как в любом «зуме протяжкой».
      viewport.zoomBy(Math.pow(1.01, -dy));
      viewport.showPivotMarker(viewport.pivotPoint());
    }
    return;
  }

  if (stroke && strokeMesh) {
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const p of (pts.length ? pts : [e])) strokeMove(p.clientX, p.clientY);
  }
  // Кольцо кисти показывает, куда ляжет краска. У выбора объекта краски
  // нет, и кольцо только врало бы про размер мазка.
  const безКисти = state.tool === 'select' || VIEW_TOOLS.has(state.tool) || LASSO_TOOLS.has(state.tool);
  if (over && !безКисти) {
    viewport.showCursor(viewport.pick(e.clientX, e.clientY), brushRadiusWorld());
  } else if (безКисти) {
    viewport.showCursor(null, 0);
  }
});

window.addEventListener('pointerup', () => {
  if (decal.drag?.pane === 'view') decalPointer('view', 'up');
  if (lasso) lassoUp();
  if (navDrag) { navDrag = null; viewport.endNav(); }
  if (shapeDrag) {
    hidePreview();
    applyShape3D(shapeDrag.mesh, shapeDrag.a, shapeDrag.b);
    shapeDrag = null;
    return;
  }
  if (stroke) endStroke();
});
el.addEventListener('contextmenu', (e) => e.preventDefault());

/* ── Аппликация ────────────────────────────────────────────────── */

/**
 * Картинка ставится углами поверх вьюпорта или развёртки и впекается в слой
 * по Enter. Пока не впечена, вид можно крутить: на модели картинка стоит на
 * экране, как проектор, и ляжет на то, что окажется под ней в миг наложения.
 *
 * Углы живут в координатах своей панели: на модели — пиксели холста, в
 * развёртке — тексели (картинка едет вместе с полотном при сдвиге и зуме).
 */
const decal = { img: null, quad: null, pane: null, drag: null, part: null, anchor: null };
// Одна деталь: аппликация ложится только на связную оболочку под первым
// щелчком. Волосы, нависшие над лицом, тогда не перехватывают картинку и не
// загораживают его — краска ложится и под ними.
state.decalPart = loadPrefs().decalPart ?? true;
$('decal-part').checked = state.decalPart;

/**
 * Деталь под точкой экрана: связная оболочка меша — то, что держится вместе
 * общими рёбрами. У составной модели это часть меша (волосы, лицо, тело —
 * отдельные куски одной геометрии), у сундука — доска или оковка.
 */
function decalPartAt(clientX, clientY) {
  if (!state.decalPart) return null;
  const hit = viewport.pick(clientX, clientY);
  if (!hit) return null;
  const set = floodFaces(hit.cache, hit.faceIndex, 180, 'geom');
  const tris = new Uint8Array(hit.cache.triCount);
  for (const t of set) tris[t] = 1;
  return { mesh: hit.mesh, tris };
}
const decalOv = { view: new DecalOverlay(el), uv: new DecalOverlay($('uv-body')) };

/** Углы картинки в пикселях холста своей панели. */
function decalScreenQuad() {
  if (decal.pane === 'uv') return decal.quad.map((c) => uvEditor._toScreen(c.x, c.y));
  return decal.quad;
}

/** Где лежит холст панели внутри её контейнера — туда кладётся слой. */
function paneBox(canvas, host) {
  const c = canvas.getBoundingClientRect(), h = host.getBoundingClientRect();
  return { left: c.left - h.left, top: c.top - h.top, width: c.width, height: c.height };
}

function drawDecal() {
  const on = decal.quad && decal.img && state.tool === 'decal';
  const view = on && decal.pane === 'view';
  const uv = on && decal.pane === 'uv' && state.uvOpen && !!uvEditor.target;
  // Над моделью картинку рисует видеокарта прямо на поверхности — сверху
  // остаются только рамка и ручки.
  if (view) {
    decalOv.view.show(decal.img, decal.quad, paneBox(viewport.renderer.domElement, el), false);
    viewport.setDecalPreview(decal.img, quadInverse(decal.quad),
      { flow: state.brush.flow ?? 1, frontOnly: state.frontOnly, part: decal.part });
  } else {
    decalOv.view.hide();
    viewport.setDecalPreview(null);
  }
  if (uv) decalOv.uv.show(decal.img, decalScreenQuad(), paneBox(uvEditor.canvas, $('uv-body')));
  else decalOv.uv.hide();
}

function syncDecalUI() {
  const img = decal.img;
  $('decal-thumb').hidden = !img;
  if (img) $('decal-thumb').src = img.url;
  $('decal-name').textContent = img ? img.name : t('decal.none');
  $('decal-apply').disabled = !decal.quad;
  $('decal-cancel').disabled = !decal.quad;
}

/**
 * Ввод аппликации в панели.
 * @param {'view'|'uv'} pane
 * @param {object} [p] точка развёртки (у панели развёртки), в текселях
 */
function decalPointer(pane, phase, e, p) {
  const canvas = pane === 'uv' ? uvEditor.canvas : viewport.renderer.domElement;
  if (phase === 'up') {
    if (decal.drag) { decal.drag = null; syncDecalUI(); setStatusHint(t('decal.hint')); }
    return;
  }
  const r = canvas.getBoundingClientRect();
  const s = { x: e.clientX - r.left, y: e.clientY - r.top };      // экран панели
  const at = pane === 'uv' ? { x: p.tx, y: p.ty } : s;             // пространство углов

  if (phase === 'down') {
    if (!decal.img) { $('decal-input').click(); return; }
    // Своя картинка в этой же панели: ручки, перенос, вращение.
    const hit = decal.quad && decal.pane === pane ? hitQuad(decalScreenQuad(), s.x, s.y) : null;
    if (hit) {
      decal.drag = { pane, kind: hit, start: decal.quad.map((c) => ({ ...c })), from: at };
    } else {
      // Мимо — ставим заново: протяжкой задаётся ширина, высота по картинке.
      // Деталь берётся под первым щелчком и дальше не меняется, куда бы
      // картинку ни тянули.
      decal.pane = pane;
      decal.anchor = pane === 'view' ? { x: e.clientX, y: e.clientY } : null;
      decal.part = pane === 'view' ? decalPartAt(e.clientX, e.clientY) : null;
      decal.drag = { pane, kind: { kind: 'new' }, from: at };
      decal.quad = quadFromDrag(at, at, decal.img.w / decal.img.h, decalDefaultSize(pane));
    }
    drawDecal();
    return;
  }

  // Движение: тянем — правим; нет — подсказываем курсором, что будет.
  const d = decal.drag;
  if (d && d.pane === pane) {
    decal.quad = d.kind.kind === 'new'
      ? quadFromDrag(d.from, at, decal.img.w / decal.img.h, decalDefaultSize(pane))
      : dragQuad(d.kind, d.start, d.from, at, e.shiftKey);
    drawDecal();
    return;
  }
  const hit = decal.quad && decal.pane === pane ? hitQuad(decalScreenQuad(), s.x, s.y) : null;
  canvas.style.cursor = !hit ? 'crosshair'
    : hit.kind === 'move' ? 'move'
    : hit.kind === 'rotate' ? 'grab'
    : (hit.i % 2 ? 'nesw-resize' : 'nwse-resize');
}

/** Размер картинки, поставленной щелчком: треть кадра или четверть атласа. */
function decalDefaultSize(pane) {
  if (pane === 'uv') return (activeTarget()?.size || 1024) * 0.25;
  const c = viewport.renderer.domElement;
  return Math.min(c.clientWidth, c.clientHeight) * 0.35;
}

function cancelDecal() {
  decal.quad = null;
  decal.drag = null;
  decal.part = null;
  drawDecal();
  syncDecalUI();
}

/** Впечь картинку в активный слой — одним шагом истории на все объекты. */
function applyDecal() {
  if (!decal.quad || !decal.img) return;
  const stencil = decalStencil(decal.img, decal.quad);
  const entries = [];

  if (decal.pane === 'uv') {
    const target = activeTarget();
    const cache = activeMesh?.userData.paintCache;
    if (target && cache) {
      target.activeIndex = state.activeLayer;
      const s = new Stroke(target, cache, strokeOpts());
      s.stampStencil2D(stencil, quadBounds(decal.quad), state.brush);
      const entry = s.end('act.decal');
      if (entry) entries.push(entry);
    }
  } else {
    // На модели — на деталь под первым щелчком, а без неё на все объекты
    // разом: картинка поверх сундука ложится и на доски, и на окованные углы.
    // Что видно, решает снимок глубины — у детали её собственный.
    const canvas = viewport.renderer.domElement;
    const part = decal.part;
    const dep = viewport.depthSnapshot(part);
    const clip = quadBounds(decal.quad);
    const where = part ? viewport.paintables.filter((p) => p.mesh === part.mesh) : viewport.paintables;
    for (const { mesh, cache } of where) {
      const target = targets.get(mesh);
      if (!target) continue;
      target.activeIndex = state.activeLayer;
      const { mvp, viewDir } = projectionFor(mesh);
      const s = new Stroke(target, cache, strokeOpts());
      s.stampProjected(mvp.elements, canvas.clientWidth, canvas.clientHeight,
                       stencil, viewDir, state.brush, state.frontOnly,
                       { clip, depth: dep && { ...dep, mv: dep.mvFor(mesh) }, tris: part?.tris });
      const entry = s.end('act.decal');
      if (entry) entries.push(entry);
    }
  }

  if (!entries.length) { setStatusHint(t('decal.missed')); return; }
  history.push(entries.length === 1 ? entries[0] : { label: 'act.decal', group: entries });
  warnHiddenPaint();
  state.painted = true;
  cancelDecal();
  viewport.syncTransparency();
  refreshUV();
  renderHistory();
  syncHistoryButtons();
}

$('decal-pick').addEventListener('click', () => $('decal-input').click());
$('decal-part').addEventListener('change', (e) => {
  state.decalPart = e.target.checked;
  savePrefs({ decalPart: state.decalPart });
  // Поставленная картинка переходит на новое правило сразу — по той же
  // точке первого щелчка.
  if (decal.quad && decal.pane === 'view' && decal.anchor) {
    decal.part = decalPartAt(decal.anchor.x, decal.anchor.y);
    drawDecal();
  }
});
$('decal-apply').addEventListener('click', applyDecal);
$('decal-cancel').addEventListener('click', cancelDecal);
$('decal-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    decal.img = await loadDecalImage(f);
    // Поставленная рамка остаётся, но под пропорции новой картинки её
    // никто не подгоняет: углы — уже работа человека.
    setStatusHint(t(decal.quad ? 'decal.hint' : 'decal.place'));
  } catch (err) {
    console.error(err);
    setStatusHint(t('decal.readFailed'));
  }
  syncDecalUI();
  drawDecal();
});
syncDecalUI();
// Панели меняют размер — слой поверх переезжает вместе с холстом.
window.addEventListener('resize', () => requestAnimationFrame(drawDecal));

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

/**
 * Инструменты вида: то же, что делают колесо и правая кнопка, но взятое в
 * руку. Кнопками мыши это быстрее, а значками — понятнее и доступно там, где
 * второй кнопки нет (перо, трекпад).
 */
const VIEW_TOOLS = new Set(['pan', 'orbit', 'zoom']);
/** Лассо: вольное и по точкам. Выделяют, а не красят. */
const LASSO_TOOLS = new Set(['lasso', 'lasso-poly']);

function setTool(tool) {
  // Незамкнутый контур другому инструменту ни к чему.
  if (tool !== state.tool) cancelLasso();
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  // Сдвиг уже умеет OrbitControls — тем же переключателем, что и пробел.
  // Вращение и приближение ведём сами: у них своя точка вращения.
  if (!spaceDown) viewport.setLeftButtonPan(tool === 'pan');
  el.style.cursor = tool === 'orbit' ? 'grab' : tool === 'zoom' ? 'zoom-in'
                  : LASSO_TOOLS.has(tool) ? 'crosshair' : '';
  uvEditor.canvas.style.cursor = LASSO_TOOLS.has(tool) ? 'crosshair' : '';
  syncToolOptions();
  syncLayers();
  // Окно выбора — сразу по нажатию: браузер открывает его только в ответ
  // на действие человека, а выбор инструмента и есть это действие.
  if (tool === 'decal' && !decal.img) $('decal-input').click();
  drawDecal();
}
/** Клавиши инструментов — для тултипа. Лассо по точкам — второе нажатие L. */
const TOOL_HINTS = { select: 'V', pan: 'H', orbit: 'O', zoom: 'Z', lasso: 'L', 'lasso-poly': 'L L',
  brush: 'B', rect: 'R', ellipse: 'C', text: 'T', decal: 'A', 'fill-faces': 'F', 'fill-island': 'G',
  eraser: 'E', eyedropper: 'I' };

initTooltips((id) => {
  const ключ = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());   // fill-faces → fillFaces
  return { title: t('tool.' + ключ), key: TOOL_HINTS[id], text: t('tip.' + ключ) };
});

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
/**
 * Полоска параметров показывает только то, что относится к выбранному
 * инструменту: у кисти своих настроек в ней нет, и пустая рамка над моделью
 * была бы просто помехой.
 */
function syncToolOptions() {
  document.querySelectorAll('#tool-options .opt-group').forEach((g) => {
    g.classList.toggle('on', g.dataset.for.split(' ').includes(state.tool));
  });
}

function syncShapeUI() {
  $('shape-fill').classList.toggle('on', !state.shape.outline);
  $('shape-outline').classList.toggle('on', state.shape.outline);
  $('shape-thickness-val').textContent = state.shape.thickness + ' px';
  $('shape-font-val').textContent = state.shape.font + ' px';
  $('shape-family').value = state.shape.family;
}
$('shape-fill').addEventListener('click', () => { state.shape.outline = false; syncShapeUI(); });
$('shape-outline').addEventListener('click', () => { state.shape.outline = true; syncShapeUI(); });
$('shape-thickness').addEventListener('input', (e) => { state.shape.thickness = +e.target.value; syncShapeUI(); });
$('shape-font').addEventListener('input', (e) => { state.shape.font = +e.target.value; syncShapeUI(); });
$('shape-text').addEventListener('input', (e) => { state.shape.text = e.target.value; });

// Список шрифтов: каждый пункт написан своим шрифтом — выбирают по виду
// буквы, а не по названию.
for (const f of FONTS) {
  const o = document.createElement('option');
  o.value = f.name;
  o.textContent = f.key ? t(f.key) : f.name;
  if (f.key) o.dataset.i18n = f.key;
  o.style.fontFamily = f.css;
  $('shape-family').appendChild(o);
}
$('shape-family').addEventListener('change', (e) => { state.shape.family = e.target.value; });

$('fill-angle').addEventListener('input', (e) => {
  state.fillAngle = +e.target.value;
  $('fill-angle-val').textContent = e.target.value + '°';
});

function setColor(rgb) { setMaterial({ color: rgb, name: () => t('mat.paint') }); }

/**
 * Сменить материал кисти целиком или частями.
 * @param {object} patch {color, color2, pattern, roughness, metalness, opacity, alpha, name}
 */
/** Имя модели: у файла это его имя, у демо — подпись, зависящая от языка. */
function имяМодели() {
  return typeof modelName === 'function' ? modelName() : modelName;
}

/** Имя материала: готовая строка или функция, считающая её под язык. */
function имяМатериала() {
  return typeof state.matName === 'function' ? state.matName() : state.matName;
}

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

  $('mat-chip-name').textContent = имяМатериала();

  const bits = [UI.rgbToHex(state.color).toUpperCase()];
  bits.push(t('mat.roughShort', Math.round(state.roughness * 100)));
  if (state.metalness > 0.01) bits.push(t('mat.metalShort', Math.round(state.metalness * 100)));
  if (state.opacity < 0.99) bits.push(t('mat.opacityShort', Math.round((1 - state.opacity) * 100)));
  if (state.pattern.id === 'image') bits.push(t('mat.ownTexture'));
  else if (state.pattern.id !== 'none') bits.push(t('mat.patternShort'));
  $('mat-chip-sub').textContent = bits.join(' · ');
}

// Быстрая палитра — это обычная краска: цвет, матовая поверхность, без узора.
UI.renderSwatches($('quick-mats'), (hex) => setMaterial({
  color: UI.hexToRgb(hex),
  pattern: { id: 'none' },
  roughness: 0.9, metalness: 0, opacity: 1,
  name: () => t('mat.chipName', hex.toUpperCase()),
}));

/* ── Слои ──────────────────────────────────────────────────────── */

function syncLayers() {
  const вариант = state.variants.find((v) => v.id === state.activeVariant);
  UI.renderLayers($('layer-list'), activeTarget(),
    { activeIndex: state.activeLayer },
    {
      // Слои других вариантов не показываются: в них сейчас не красят.
      hidden: (L) => !слойВВарианте(L),
      variantTip: вариант ? (L) => t(L.variant == null ? 'layers.common' : 'layers.own', имяВарианта(вариант)) : null,
      onToggleVariant: toggleLayerVariant,
      onSelect: setActiveLayer,
      onToggleVisible: (i) => {
        const vis = !refLayers()[i].visible;
        eachTarget((t) => { t.layers[i].visible = vis; t.compositeRect(null); });
        syncLayers(); refreshUV();
      },
      onRename: (i, name) => { eachTarget((t) => { t.layers[i].name = name; t.layers[i].auto = null; }); syncLayers(); },
    });

  const L = refLayers();
  $('layer-count').textContent = L ? String(L.filter(слойВВарианте).length) : '';
  if (L) {
    const cur = L[state.activeLayer];
    $('layer-opacity').value = Math.round(cur.opacity * 100);
    $('layer-opacity-val').textContent = Math.round(cur.opacity * 100) + '%';
    $('layer-blend').value = cur.blend;
  }
}

$('btn-layer-add').addEventListener('click', addLayer);
$('btn-layer-del').addEventListener('click', removeLayer);
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

  row(t('hist.start'), -1);
  history.entries.forEach((e, i) => row(`${i + 1}. ${t(e.label)}`, i));

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
  syncUVList();
  app.classList.toggle('uv-open', open);
  savePrefs({ uvOpen: open });
  if (open) {
    requestAnimationFrame(() => { uvEditor.resize(); refreshUV(); });
  }
  viewport.resize();
  drawDecal();
}

$('uv-close').addEventListener('click', () => setUVOpen(false));
$('uv-fit').addEventListener('click', () => { uvEditor.fit(); uvEditor.draw(); });
$('uv-wire').addEventListener('change', (e) => setShowWire(e.target.checked));
$('uv-preview-wire').addEventListener('change', (e) => setShowWire(e.target.checked));
$('btn-uv-open').addEventListener('click', (e) => { e.stopPropagation(); setUVOpen(true); });

let uvPending = false;
function scheduleUV() {
  if (uvPending) return;
  uvPending = true;
  requestAnimationFrame(() => { uvPending = false; refreshUV(); });
}
function refreshUV() {
  drawUVRow(activeMesh);
  if (!state.uvOpen) return;
  uvEditor.setTarget(activeTarget(), activeMesh?.userData.paintCache);
  $('uv-mesh').textContent = activeMesh?.name ? `· ${activeMesh.name}` : '';
}

/* ── Список развёрток ──────────────────────────────────────────── */

/** Короткий создатель элемента: в этом файле `el` занят вьюпортом. */
function элемент(тег, класс, текст) {
  const у = document.createElement(тег);
  if (класс) у.className = класс;
  if (текст != null) у.textContent = текст;
  return у;
}

// Карта меша → строка списка: по ней перерисовывается только нужная,
// а не весь список. За мазок это происходит десятки раз.
const uvRows = new Map();

/**
 * Список развёрток модели — по карте на меш.
 *
 * У составной модели каждый объект несёт свою развёртку, и одной карточкой
 * их не показать: непонятно, чья она. Список делает выбор явным, а заодно
 * заменяет кнопку «Развёртка» — щелчок по строке открывает нужную карту.
 */
function renderUVList() {
  const box = $('uv-list');
  box.textContent = '';
  uvRows.clear();

  if (!viewport.paintables.length) {
    box.appendChild(элемент('div', 'uv-empty', t('uv.none')));
    $('btn-uv-rebuild').hidden = true;
    return;
  }

  for (const { mesh, cache } of viewport.paintables) {
    const row = элемент('button', 'uv-row');
    const thumb = элемент('div', 'uv-thumb');
    const canvas = document.createElement('canvas');
    thumb.appendChild(canvas);
    const info = элемент('div', 'uv-row-info');
    // Имя меша не переводится: оно уходит в файл и в списки 3D-редакторов.
    const мета = элемент('div', 'uv-row-meta', t('uv.rowTris', cache.triCount));
    if ((cache.overlap || 0) > OVERLAP_LIMIT) {
      мета.append(' · ', элемент('span', 'uv-overlap', t('uv.rowOverlap', Math.round(cache.overlap * 100))));
    }
    info.append(элемент('div', 'uv-row-name', mesh.name || t('model.unnamed')), мета);
    row.append(thumb, info);
    row.addEventListener('click', () => {
      // Щелчок по уже открытой развёртке закрывает её — как переключатель.
      if (activeMesh === mesh && state.uvOpen) { setUVOpen(false); return; }
      setActiveMesh(mesh);
      setUVOpen(true);
    });
    box.appendChild(row);
    uvRows.set(mesh, { row, canvas });
  }
  // Видна всегда, пока есть что перестраивать; красная — при наложении.
  $('btn-uv-rebuild').hidden = !viewport.paintables.length;
  $('btn-uv-rebuild').classList.toggle('warn', мешиСНаложением().length > 0);
  syncUVList();
}

/** Подсветить строку активного меша и обновить её карту. */
function syncUVList() {
  for (const [mesh, { row }] of uvRows) {
    row.classList.toggle('on', mesh === activeMesh);
    row.classList.toggle('open', mesh === activeMesh && state.uvOpen);
  }
  // Выгружается только выделенная (открытая) развёртка — нет её, нечего и
  // выгружать.
  $('btn-uv-png').disabled = !(state.uvOpen && activeMesh && targets.get(activeMesh));
  drawUVRow(activeMesh);
}

/** Перерисовать карту одной строки. Без меша — ничего не делаем. */
function drawUVRow(mesh) {
  const row = mesh && uvRows.get(mesh);
  if (!row) return;
  UI.drawUVPreview(row.canvas, targets.get(mesh), mesh.userData.paintCache, state.showWire);
}

/** Перерисовать карты всех строк — после загрузки и при смене сетки. */
function drawUVRows() {
  for (const [mesh] of uvRows) drawUVRow(mesh);
}

function setShowWire(on) {
  state.showWire = on;
  $('uv-wire').checked = on;
  $('uv-preview-wire').checked = on;
  drawUVRows();
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

/**
 * Показ модели — как строка вида в 3DModelist. Глина и нормали подменяют
 * материал покраски целиком; сетка кладёт рёбра поверх покраски; «Без
 * света» — та же покраска без светотени.
 */
function applyShading() {
  const m = state.viewMode;
  viewport.setDisplayMode(m === 'clay' || m === 'normals' ? m : state.unlit ? 'flat' : 'material');
  viewport.setVerticesVisible(m === 'wire');
  viewport.setFacets(state.facets);
  syncViewUI();
}
function setViewMode(mode) { state.viewMode = mode; applyShading(); }
function setUnlit(on) { state.unlit = on; applyShading(); }
function setFacets(on) { state.facets = on; savePrefs({ facets: on }); applyShading(); }

function setLight(patch) {
  Object.assign(state.light, patch);
  viewport.setLight(state.light);
  savePrefs({ light: state.light });
  syncLightUI();
}
function setSpin(on) { viewport.setSpin(on); syncLightUI(); }

function syncLightUI() {
  const L = state.light;
  $('light-power').value = L.power;
  $('light-power-val').textContent = Math.round(L.power * 100) + '%';
  $('light-angle').value = L.angle;
  $('light-angle-val').textContent = L.angle + '°';
  $('light-spin').checked = viewport.spin;
  $('light-unlit').checked = state.unlit;
}

function setGrid(on) { state.grid = on; viewport.setGridVisible(on); syncViewUI(); }


const lightPop = $('light-pop');
function syncViewUI() {
  const cur = viewport.currentViewName();
  document.querySelectorAll('#view-flyout button').forEach((b) => {
    // «3/4» не подсвечиваем по совпадению: любой свободный разворот тоже
    // «не осевой», и кнопка горела бы всё время.
    b.classList.toggle('on', cur !== 'user' && b.dataset.view === cur);
  });
  $('ov-proj').classList.toggle('on', viewport.projection === 'ortho');
  $('ov-grid').classList.toggle('on', state.grid);
  document.querySelectorAll('#view-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.viewMode));
  $('vm-facets').classList.toggle('on', state.facets);
  $('ov-light').classList.toggle('on', lightPop.classList.contains('open'));
  syncLightUI();
}

const flyout = $('view-flyout');
function closeFlyout() { flyout.classList.remove('open'); $('ov-views').classList.remove('on'); }

$('ov-views').addEventListener('click', () => {
  closePoseFlyout();
  closeLightPop();
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

/* ── Положение модели ──────────────────────────────────────────── */

/*
 * Модель при открытии всегда встаёт на пол в центр мира. Поворот — «где
 * перед, где верх» — задаёт человек: в файле этого нет. Заданное
 * запоминается по модели (имя + размер, как у недавних), и в следующий раз
 * она открывается уже стоящей как надо.
 */
let modelKey = 'demo';
const POSES = 'paint-tool.poses';
function loadPoses() {
  try { return JSON.parse(localStorage.getItem(POSES) || '{}'); } catch { return {}; }
}
function savePose(q) {
  const все = loadPoses();
  const как_в_файле = Math.abs(q[3]) > 0.999999;          // поворота нет
  if (как_в_файле) delete все[modelKey]; else все[modelKey] = q;
  try { localStorage.setItem(POSES, JSON.stringify(все)); } catch { /* приватный режим */ }
}

/**
 * Поменять положение модели. После поворота модель заново ставится на пол,
 * камера — на вид «спереди» (или прежний ракурс для поворотов на 90°), и
 * модель вписывается в кадр.
 */
function applyPose(что) {
  if (!viewport.model) return;
  let q;
  if (что === 'front') q = viewport.poseFrontFromCamera();
  else if (что === 'up') q = viewport.poseUpFromCamera();
  else if (что === 'left') q = viewport.poseTurn(90);
  else if (что === 'right') q = viewport.poseTurn(-90);
  else q = viewport.setPose(null);
  savePose(q);
  if (что === 'front' || что === 'up') viewport.setView('front');
  viewport.frameModel(true);
  syncViewUI();
  syncPoseUI();
  syncModelInfo();
  setStatusHint(t(что === 'reset' ? 'status.poseReset' : 'status.poseSet'));
}

/**
 * Модель открыта из файла — любым путём: диалогом, перетаскиванием, из
 * недавних.
 *
 * 🔴 Начальный экран закрываем здесь, а не в местах вызова: кнопка «Открыть
 * модель» на нём только зовёт диалог, файл приходит в общий обработчик, и
 * экран оставался висеть поверх открытой модели.
 */
function модельОткрыта() {
  welcome.hide();
  // Положение ещё не задавали — подсказать, где это делается: перед модели в
  // файле не записан, и без подсказки кнопку не найти.
  if (!loadPoses()[modelKey]) показатьПодсказкуПоложения();
}

let таймерПодсказки = 0;
function показатьПодсказкуПоложения() {
  const п = $('pose-callout');
  п.classList.add('on');
  $('ov-pose').classList.add('hint');
  clearTimeout(таймерПодсказки);
  таймерПодсказки = setTimeout(спрятатьПодсказкуПоложения, 9000);
}
function спрятатьПодсказкуПоложения() {
  clearTimeout(таймерПодсказки);
  $('pose-callout').classList.remove('on');
  $('ov-pose').classList.remove('hint');
}
$('pose-callout').addEventListener('click', () => {
  спрятатьПодсказкуПоложения();
  $('ov-pose').click();
});

function syncPoseUI() {
  const повёрнута = Math.abs(viewport.pose()[3]) < 0.999999;
  $('ov-pose').classList.toggle('changed', повёрнута);
}

const poseFlyout = $('pose-flyout');
function closePoseFlyout() { poseFlyout.classList.remove('open'); $('ov-pose').classList.remove('on'); }
$('ov-pose').addEventListener('click', () => {
  closeFlyout();
  closeLightPop();
  спрятатьПодсказкуПоложения();
  const open = poseFlyout.classList.toggle('open');
  $('ov-pose').classList.toggle('on', open);
});
document.addEventListener('pointerdown', (e) => {
  if (!poseFlyout.classList.contains('open')) return;
  if (inside(poseFlyout, e.target) || inside($('ov-pose'), e.target)) return;
  closePoseFlyout();
});
poseFlyout.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', () => { applyPose(b.dataset.pose); closePoseFlyout(); });
});

$('ov-center').addEventListener('click', () => viewport.centerCamera());
$('ov-frame').addEventListener('click', () => viewport.centerCamera());
$('ov-proj').addEventListener('click', () => setProjection(viewport.projection === 'ortho' ? 'persp' : 'ortho'));
$('ov-grid').addEventListener('click', () => setGrid(!state.grid));
document.querySelectorAll('#view-mode button').forEach((b) => {
  b.addEventListener('click', () => setViewMode(b.dataset.mode));
});
$('vm-facets').addEventListener('click', () => setFacets(!state.facets));

/* ── Свет: окошко у кнопки колонки ─────────────────────────────── */

function closeLightPop() { lightPop.classList.remove('open'); $('ov-light').classList.remove('on'); }
$('ov-light').addEventListener('click', () => {
  closeFlyout();
  closePoseFlyout();
  const open = lightPop.classList.toggle('open');
  $('ov-light').classList.toggle('on', open);
});
document.addEventListener('pointerdown', (e) => {
  if (!lightPop.classList.contains('open')) return;
  if (inside(lightPop, e.target) || inside($('ov-light'), e.target)) return;
  closeLightPop();
});
$('light-power').addEventListener('input', (e) => setLight({ power: Number(e.target.value) }));
$('light-angle').addEventListener('input', (e) => setLight({ angle: Number(e.target.value) }));
$('light-spin').addEventListener('change', (e) => setSpin(e.target.checked));
$('light-unlit').addEventListener('change', (e) => setUnlit(e.target.checked));
$('light-reset').addEventListener('click', () => setLight({ power: 1, angle: 0 }));

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
    // Указатель меряется в пикселях экрана, а ширина панели живёт под
    // масштабом интерфейса — переводим.
    const w = Math.max(190, Math.min(560, (window.innerWidth - ev.clientX) / uiScale()));
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
    name: имяМатериала(),
  }),
  setMaterial: (patch) => setMaterial(patch),
});

const helpModal = createHelpModal();

const saveAsModal = createSaveAsModal({ save: (формат) => saveAs(формат) });

const settingsModal = createSettingsModal({
  getLang,
  setLang,
  getTexSize: () => state.texSize,
  setTexSize: (v) => setTexSize(v),
  getUiScale: uiScale,
  setUiScale: (v) => setUiScale(v),
  getStartup: () => loadPrefs().showWelcome !== false,
  setStartup: (v) => savePrefs({ showWelcome: v }),
});

/* ── ИИ: инструменты для MCP ───────────────────────────────────── */

/**
 * Что страница даёт ИИ. Сервер живёт в оболочке Electron и зовёт
 * `window.__mcp.call(…)`; в браузере объект есть, но звать его некому.
 * Заливка ИИ — тот же `Stroke`, что у человека: шаг в истории, ⌘Z отменяет.
 */
function aiFill(mesh, set, { color, roughness, metalness, alpha }, layer) {
  const target = targets.get(mesh);
  const cache = mesh.userData.paintCache;
  if (!target || !cache) return;
  target.activeIndex = layer ?? state.activeLayer;
  const s = new Stroke(target, cache, {
    channel: 'rgba', mode: 'paint', color, color2: color,
    opacity: 1, alpha, roughness, metalness, pattern: { id: 'none' },
  });
  s.fillTriangles(set);
  const entry = s.end('act.aiFill');
  if (entry) history.push(entry);
  target.activeIndex = state.activeLayer;
  state.painted = true;
  viewport.syncTransparency();
  refreshUV();
  drawUVRow(mesh);
}

window.__mcp = createMcpTools({
  viewport,
  targets,
  history,
  modelName: () => имяМодели(),
  activeLayer: () => state.activeLayer,
  layers: () => (refLayers() || []).map((L, i) => ({
    index: i, name: L.auto ? t('layers.name', L.auto) : L.name, visible: L.visible !== false,
  })),
  addLayer: (name) => { addLayer(name); return state.activeLayer; },
  fillTriangles: aiFill,
  projectBytes: () => собратьПроект(),
  notify: (what, n) => setStatusHint(t('mcp.filled', n)),
});

/* ── Эффекты вида ──────────────────────────────────────────────── */

/**
 * Эффекты меняют только показ: покраска, карты и файлы прежние. Каждый
 * описан данными — где живёт, какие у него настройки и их пределы; окно,
 * меню и запоминание строятся по описанию.
 *
 * Включён всегда один: пиксель-арт поверх аниме — отдельная задача, а два
 * эффекта, молча перебивающие друг друга, путают.
 *
 * Настройки помнятся между запусками — это вкус человека, а не свойство
 * модели. А сам эффект при запуске выключен: модель, открывшаяся квадратами
 * или контуром без видимой причины, выглядит поломкой.
 */
const EFFECTS = {
  pixelArt: {
    obj: () => viewport.pixelArt,
    title: 'fx.pixelTitle', menu: 'fx.pixel', menuSettings: 'fx.pixelSettings',
    rows: [
      { kind: 'range', key: 'size', label: 'fx.size', min: 2, max: 24, fmt: (v) => v + ' px' },
      // Уровней на канал, а показываем число цветов — так понятнее: 4
      // уровня — это 64 цвета. Крайнее правое положение — «все».
      { kind: 'range', key: 'levels', label: 'fx.colors', min: 2, max: LEVELS_OFF,
        fmt: (v) => (v >= LEVELS_OFF ? t('fx.colorsAll') : String(v ** 3)) },
      { kind: 'check', key: 'outline', label: 'fx.outline' },
    ],
  },
  anime: {
    obj: () => viewport.anime,
    title: 'fx.animeTitle', menu: 'fx.anime', menuSettings: 'fx.animeSettings',
    rows: [
      { kind: 'range', key: 'steps', label: 'fx.steps', min: 2, max: 4, fmt: (v) => String(v) },
      { kind: 'range', key: 'line', label: 'fx.line', min: 0, max: 6,
        fmt: (v) => (v ? v + ' px' : t('fx.lineOff')) },
      { kind: 'check', key: 'creases', label: 'fx.creases' },
      { kind: 'range', key: 'rim', label: 'fx.rim', min: 0, max: 1, step: 0.05,
        fmt: (v) => Math.round(v * 100) + '%' },
    ],
  },
};

function effectSettings(имя) {
  const o = EFFECTS[имя].obj();
  const s = { enabled: o.enabled };
  for (const row of EFFECTS[имя].rows) s[row.key] = o[row.key];
  return s;
}

function setEffect(имя, patch) {
  const fx = EFFECTS[имя];
  const o = fx.obj();
  for (const row of fx.rows) {
    if (!(row.key in patch)) continue;
    const v = patch[row.key];
    o[row.key] = row.kind === 'check' ? !!v : Math.min(row.max, Math.max(row.min, +v));
  }
  if ('enabled' in patch) {
    o.enabled = !!patch.enabled;
    if (o.enabled) {
      for (const другое of Object.keys(EFFECTS)) {
        if (другое !== имя) { EFFECTS[другое].obj().enabled = false; EFFECTS[другое].modal?.sync(); }
      }
    }
  }
  savePrefs({ [имя]: effectSettings(имя) });
  fx.modal?.sync();
}

for (const [имя, fx] of Object.entries(EFFECTS)) {
  fx.modal = createEffectModal(fx.title, fx.rows, {
    get: () => effectSettings(имя),
    set: (patch) => setEffect(имя, patch),
  });
  const p = loadPrefs()[имя];
  if (p) setEffect(имя, { ...p, enabled: false });
}

/**
 * Начальный экран. Показывается на старте, пока человек не снимет галку, и
 * открывается из меню — чтобы вернуться к нему было чем, а не только
 * перезапуском программы.
 */
const welcome = createWelcome({
  openFile: (файл) => openFile(файл),
  openBuffer: (буфер, имя, соседи) => openBuffer(буфер, имя, соседи),
  openDemo: () => afterModelLoaded(viewport.loadDemo()),
  pickFile: () => $('file-input').click(),
  getShowOnStartup: () => loadPrefs().showWelcome !== false,
  setShowOnStartup: (v) => savePrefs({ showWelcome: v }),
});

// Кнопки сидят в заголовках секций, а заголовок сворачивает секцию —
// нажатие до него доходить не должно.
$('btn-brush-modal').addEventListener('click', (e) => { e.stopPropagation(); brushModal.open(); });
$('btn-material-modal').addEventListener('click', (e) => { e.stopPropagation(); materialModal.open(); });
$('mat-chip').addEventListener('click', () => materialModal.open());

/* ── Модель ────────────────────────────────────────────────────── */

function setActiveMesh(mesh) {
  if (activeMesh === mesh) return;
  activeMesh = mesh;
  syncSelectionOutline();
  syncLayers();
  refreshUV();
  syncUVList();
  syncStatusModel();
}

/** Меши, у которых развёртка с наложением. */
function мешиСНаложением() {
  return viewport.paintables.filter(({ cache }) => (cache.overlap || 0) > OVERLAP_LIMIT).map((p) => p.mesh);
}

/**
 * Перестроить развёртку своей: детали крупными островами рядом друг с
 * другом, без наложения.
 *
 * Развёртку из файла программа не трогает сама: в ней может лежать покраска
 * автора. С наложением красить нельзя — мазок дублируется, — и тогда кнопка
 * красная и перестраивает меши с наложением. Без наложения она перестраивает
 * все меши — когда человеку не нравится, как развёртка порезана (прежний
 * построитель дробил лицо на осколки), — и спрашивает подтверждение: годную
 * развёртку одним случайным щелчком не меняют. Всё, что уже есть на слоях (и карта
 * из файла, выпеченная в первый слой), переносится на новую развёртку.
 *
 * Журнал отмены очищается: его шаги — куски старых текселей, к новой
 * развёртке они легли бы кашей. Выделение — по той же причине.
 */
function rebuildOverlappingUV() {
  let меши = мешиСНаложением();
  if (!меши.length) {
    if (!viewport.paintables.length || !window.confirm(t('uv.rebuildConfirm'))) return;
    меши = viewport.paintables.map((p) => p.mesh);
  }
  withBusy('busy.uvRebuild', () => {
    let островов = 0;
    for (const mesh of меши) {
      const вышло = viewport.rebuildUV(mesh);
      const target = targets.get(mesh);
      if (!вышло || !target) continue;
      островов += вышло.islands;
      for (const L of target.layers) remapLayer(L, target.size, вышло.from, вышло.to);
      target.selection = null;
      target.compositeRect(null);
      target.updateTransparency?.();
      lastReport?.unwrapped?.push({ name: mesh.name || t('model.unnamed'), reason: 'overlap', islands: вышло.islands });
    }
    viewport.syncTransparency();
    history.clear();
    state.painted = true;      // геометрия другая — проект стоит сохранить
    selectionChanged();
    renderUVList();
    if (state.uvOpen) { uvEditor.setTarget(null, null); refreshUV(); uvEditor.fit(); uvEditor.draw(); }
    renderHistory();
    syncHistoryButtons();
    syncModelNotes();
    setStatusHint(t('uv.rebuilt', меши.length, островов));
  });
}

/**
 * @param {object} report что сообщил загрузчик
 * @param {string} [key] чем модель помечена для запомненного положения:
 *        файл — именем и размером, демо — 'demo'; при пересборке текстур
 *        (та же модель) остаётся прежним
 */
function afterModelLoaded(report, key) {
  modelKey = key ?? (typeof report.name === 'function' ? 'demo' : modelKey);
  cancelDecal();       // углы стояли над прежней моделью
  // Положение, в которое эту модель уже ставили, — сразу, до кадрирования.
  const поза = loadPoses()[modelKey];
  if (поза) { viewport.setPose(поза); viewport.frameModel(false); }
  syncPoseUI();
  const собрано = buildTargets(viewport.paintables, report.name);
  report.downgraded = собрано.downgraded ? собрано.size : null;
  report.upgraded = собрано.upgraded ? собрано.size : null;
  report.baked = bakeSourceColors(viewport.paintables);
  report.bakedMaps = bakeSourceMaps(viewport.paintables);
  report.bakedVariants = bakeSourceVariants(viewport.paintables, viewport.model?.userData.variants);
  modelName = report.name;
  lastReport = report;

  renderUVList();
  syncVariants();
  syncLayers();
  syncBrushLabels();
  renderHistory();
  syncHistoryButtons();
  syncStatusModel();
  syncPerf();
  if (state.uvOpen) { uvEditor.setTarget(null, null); refreshUV(); uvEditor.fit(); uvEditor.draw(); }

  syncStatusCounts();
  syncModelNotes();
  syncModelInfo();

  state.texSize = собрано.size;
}

/**
 * Заметки о модели в строке состояния.
 *
 * Пишутся кодом, поэтому `data-i18n` на них вешать нельзя — `applyDOM()`
 * затёр бы содержимое. Собираются из отчёта о загрузке заново при каждой
 * смене языка: иначе на экране остаётся вчерашний язык.
 */
function syncModelNotes() {
  const uvEl = $('stat-uv');
  const report = lastReport;
  if (!report) { uvEl.textContent = ''; uvEl.style.color = ''; return; }

  const notes = [];
  if (report.downgraded) notes.push(t('status.manyMeshes', report.downgraded));
  if (report.upgraded) notes.push(t('status.denseMesh', report.upgraded));
  if (report.noUV?.length) notes.push(t('status.noUVList', report.noUV.join(', ')));
  if (report.baked && !report.bakedMaps) notes.push(t('status.baked', report.baked));
  if (report.bakedMaps && !report.bakedVariants) notes.push(t('status.bakedMaps', report.bakedMaps));
  if (report.bakedVariants) notes.push(t('status.bakedVariants', report.bakedVariants));
  if (report.mapsDropped) notes.push(t('status.mapsDropped', report.mapsDropped));
  if (report.unwrapped?.length) {
    // Развёртку подменили — об этом надо сказать вслух: человек открыл свой
    // файл, а красит по другим координатам, чем в нём лежали.
    const островов = report.unwrapped.reduce((n, u) => n + u.islands, 0);
    notes.push(t('status.unwrapped', report.unwrapped.length, островов));
  }
  // Наложенная развёртка — не мелочь: мазок по одной грани проступит на
  // другой. Лучше сказать сразу, чем гадать, почему кисть «мажет мимо».
  // Считаем по живым мешам, а не по отчёту загрузки: после перестройки или
  // смены размера текстуры отчёт уже не тот.
  const наложение = мешиСНаложением();
  if (наложение.length) {
    const worst = Math.round(Math.max(...наложение.map((m) => m.userData.paintCache.overlap)) * 100);
    notes.push(t('status.overlap', worst, наложение.map((m) => m.name || t('model.unnamed')).join(', ')));
  }
  uvEl.textContent = notes.join(' · ');
  uvEl.style.color = наложение.length ? 'var(--danger)' : '';
}

/**
 * Строка над моделью, как в 3DModelist: ширина × глубина × высота в метрах,
 * треугольники, формат файла. Пишется кодом и переписывается сменой языка.
 */
function syncModelInfo() {
  const box = $('model-info');
  if (!viewport.model) { box.textContent = ''; return; }
  const b = new THREE.Box3().setFromObject(viewport.stand);
  const d = b.getSize(new THREE.Vector3());
  const tris = viewport.paintables.reduce((n, p) => n + p.cache.triCount, 0);
  const i = modelKey.lastIndexOf(':');
  const ext = modelKey === 'demo' ? t('info.demo') : (modelKey.slice(0, i > 0 ? i : undefined).split('.').pop() || '').toUpperCase();
  box.textContent = [
    t('info.size', d.x.toFixed(2), d.z.toFixed(2), d.y.toFixed(2)),
    t('info.tris', tris.toLocaleString(getLang())),
    ext,
  ].filter(Boolean).join(' · ');
}

/** Счётчик треугольников: разделитель разрядов зависит от языка. */
function syncStatusCounts() {
  $('stat-tris').textContent = lastReport
    ? t('status.tris',
        (lastReport.tris || 0).toLocaleString(getLang()),
        lastReport.meshes)
    : '';
}

function syncStatusModel() {
  // Надпись пишется кодом, поэтому ключа в разметке у неё нет: applyDOM()
  // затирал бы имя модели каждой сменой языка.
  $('stat-model').innerHTML = viewport.model
    ? `<b>${имяМодели()}</b> · ${t('status.mesh', activeMesh?.name || '—')}`
    : t('status.noModel');
}
function syncPerf() {
  $('stat-perf').textContent = perfMs > 0.05 ? t('status.perf', perfMs.toFixed(1)) : '';
}

let hintTimer = null;
const HINT = () => t('status.hint');
function setStatusHint(text) {
  const hint = document.querySelector('#statusbar .hint');
  clearTimeout(hintTimer);
  hint.textContent = text;
  hintTimer = setTimeout(() => { hint.textContent = HINT(); }, 2500);
}

$('file-input').multiple = true;
$('file-input').addEventListener('change', async (e) => {
  if (e.target.files.length) await openFile(e.target.files);
  e.target.value = '';
});

/** Положить файл в недавние — вместе с .mtl и текстурами. Не удалось (квота,
    приватный режим) — не беда. */
function rememberRecent(name, buffer, sidecars) {
  return addRecent(name, buffer, sidecars).catch(() => false);
}

/**
 * Снять превью открытой модели для начального экрана.
 *
 * Момент выбран не случайно: модель уже разобрана и скадрирована, значит в
 * кадре ровно то, что человек увидит в списке. Кадр перерисовывается только
 * по движению указателя, поэтому рисуем его здесь руками — иначе в снимок
 * попадёт предыдущая модель.
 */
async function rememberThumb(name, size) {
  try {
    const { снятьСВьюпорта } = await import('./thumb.js');
    viewport.renderer.render(viewport.scene, viewport.camera);
    const картинка = снятьСВьюпорта(viewport.renderer.domElement);
    if (картинка) await setThumb(recentId(name, size), картинка);
  } catch { /* превью — удобство, не обязанность */ }
}

/** Открыть модель из уже прочитанного буфера — так возвращаются недавние.
    Соседние файлы (.mtl, текстуры) хранятся вместе с моделью и приходят сюда же. */
async function openBuffer(buffer, name, sidecars = null) {
  if (isProject(name)) return openProject(buffer.slice(0), name);
  setStatusHint(t('load.loading', name));
  return withBusy('busy.open', async () => {
    try {
      const report = await viewport.loadFile(buffer.slice(0), name, sidecars && sidecars.size ? sidecars : null);
      if (!report.meshes && !report.noUV?.length) { setStatusHint(t('load.noMesh')); return false; }
      // Разбор позади, дальше считаются цели покраски — про это и пишем.
      busyNote('busy.prepare');
      afterModelLoaded(report, recentId(name, buffer.byteLength));
      модельОткрыта();
      rememberThumb(name, buffer.byteLength);
      return true;
    } catch (err) {
      setStatusHint(t('load.failed', name, err.message));
      console.error(err);
      return false;
    }
  }, name);
}

/**
 * Открыть модель. На вход можно дать не один файл, а весь комплект из папки:
 * сама модель выбирается по расширению, остальное идёт спутниками — .obj без
 * соседнего .mtl теряет цвета автора, а найти его сам браузер не может.
 *
 * @param {File|File[]|FileList} что
 */
/**
 * Файлы из перетаскивания, включая брошенную папку.
 *
 * Папка в `dataTransfer.files` не приходит вовсе — её видно только через
 * записи (`webkitGetAsEntry`). А ронять папку с моделью человек будет чаще,
 * чем выбирать файлы поштучно.
 */
async function filesFromDrop(dt) {
  const записи = [...(dt.items || [])]
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!записи.length) return [...dt.files];

  const собрано = [];
  const прочитать = (entry) => new Promise((ок) => {
    if (entry.isFile) { entry.file((f) => { собрано.push(f); ок(); }, ок); return; }
    if (!entry.isDirectory) { ок(); return; }
    const reader = entry.createReader();
    const шаг = () => reader.readEntries(async (пачка) => {
      if (!пачка.length) { ок(); return; }
      // Вложенные папки не обходим: комплект модели лежит одной папкой.
      await Promise.all(пачка.filter((e) => e.isFile).map(прочитать));
      шаг();
    }, ок);
    шаг();
  });
  await Promise.all(записи.map(прочитать));
  return собрано.length ? собрано : [...dt.files];
}

async function openFile(что) {
  const набор = что instanceof File ? [что] : [...что];
  // Проект открывается сам по себе: модель и слои у него внутри.
  const проект = набор.find((f) => isProject(f.name));
  if (проект) return openProject(await проект.arrayBuffer(), проект.name);
  const file = набор.find((f) => isSupported(f.name) && !isSidecar(f.name));
  if (!file) {
    const первый = набор[0];
    setStatusHint(t('load.unknown', (первый && extensionOf(первый.name)) || первый?.name || ''));
    return false;
  }
  const спутники = new Map();
  for (const f of набор) {
    if (f === file || !isSidecar(f.name)) continue;
    спутники.set(f.name.split(/[\\/]/).pop().toLowerCase(), await f.arrayBuffer());
  }
  // В приложении соседей .obj (.mtl и его картинки) оболочка читает сама:
  // выбирают обычно один файл модели, а цвета автора лежат рядом.
  if (extensionOf(file.name) === 'obj' && window.painterHost?.model?.companions) {
    try {
      for (const f of await window.painterHost.model.companions(file)) {
        const ключ = f.name.toLowerCase();
        if (!спутники.has(ключ)) спутники.set(ключ, f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength));
      }
    } catch { /* нет соседей — откроем как есть */ }
  }

  setStatusHint(t('load.loading', file.name));
  return withBusy('busy.open', async () => {
    try {
      const buf = await file.arrayBuffer();
      const report = await viewport.loadFile(buf, file.name, спутники);
      if (!report.meshes && !report.noUV?.length) {
        setStatusHint(t('load.noMesh'));
        return false;
      }
      busyNote('busy.prepare');
      afterModelLoaded(report, recentId(file.name, buf.byteLength));
      модельОткрыта();
      // Превью дописывается к уже сохранённой записи, поэтому сначала запись.
      await rememberRecent(file.name, buf, спутники);
      rememberThumb(file.name, buf.byteLength);
      return true;
    } catch (err) {
      setStatusHint(t('load.failed', file.name, err.message));
      console.error(err);
      return false;
    }
  }, file.name);
}

el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
el.addEventListener('dragleave', () => el.classList.remove('dragover'));
el.addEventListener('drop', async (e) => {
  e.preventDefault();
  el.classList.remove('dragover');
  const набор = await filesFromDrop(e.dataTransfer);
  if (набор.length) await openFile(набор);
});

function setTexSize(next) {
  if (next === state.texSize) return;
  if (state.painted && !confirm(t('confirm.texSize'))) return;
  state.texSize = next;
  state.texSizeBase = next;
  // Выбор человека для этой модели — сильнее правила о плотных моделях.
  state.texSizeManualFor = modelName;
  const tris = $('stat-tris').textContent;
  withBusy('busy.texSize', () => {
    afterModelLoaded({ name: modelName, meshes: viewport.paintables.length, tris: 0, noUV: [] });
    $('stat-tris').textContent = tris;
  }, next);
}

/* ── Сохранение ────────────────────────────────────────────────── */

/**
 * Сохранить набор файлов.
 *
 * 🔴 Больше одного файла — одна папка, а не окно на каждый: Electron на
 * каждое «скачивание» показывает своё окно сохранения, и OBJ с материалом и
 * картой спрашивал три раза подряд. Место выбирается сразу по нажатию — до
 * экспорта под индикатором, иначе браузер уже не даст открыть окно выбора.
 *
 * @param {string} имяПапки папка, которая будет создана в выбранном месте
 * @param {number} сколько сколько файлов будет — решает, нужна ли папка
 * @param {() => Promise<{name: string, blob: Blob}[]>} собрать
 * @returns {Promise<number>} сколько файлов сохранено
 */
async function сохранитьФайлы(имяПапки, сколько, собрать, ключЗанятости, ...значения) {
  let место;                            // undefined — папкой не сохраняем
  if (сколько > 1 && canSaveToFolder()) {
    try { место = await pickFolder(); } catch (err) { console.warn(err); }
    if (место === null) { setStatusHint(t('save.cancelled')); return 0; }
  }
  return withBusy(ключЗанятости, async () => {
    try {
      const файлы = await собрать();
      if (место) {
        const папка = await writeToFolder(место, имяПапки, файлы);
        setStatusHint(t('save.toFolder', файлы.length, папка));
      } else {
        for (const { name, blob } of файлы) downloadBlob(blob, name);
        setStatusHint(t('save.done', файлы.length));
      }
      return файлы.length;
    } catch (err) {
      setStatusHint(t('save.failed', err.message));
      console.error(err);
      return 0;
    }
  }, ...значения);
}

/**
 * Карты покраски по мешам — в том виде, в каком их ждёт экспортёр.
 * Карта материала прикладывается только если по ней красили: пустая
 * заставила бы редактор считать всю модель шероховатым металлом.
 */
function картыДляЭкспорта(сВариантами = false) {
  const карты = new Map();
  const варианты = сВариантами && state.variants.length > 1 ? state.variants : null;
  for (const [mesh, t] of targets) {
    if (варианты) {
      // Каждый вариант — своими картами. Карта материала — у всех, если
      // поверхностью красили хоть в одном: материалы вариантов должны быть
      // одного устройства, иначе переключение меняло бы и блеск.
      const сборки = варианты.map((v) => ({ v, r: t.renderVariant(v.id) }));
      const сМатериалом = сборки.some(({ r }) => r.materialPaint);
      карты.set(mesh, {
        variants: сборки.map(({ v, r }) => ({
          name: имяВарианта(v), color: r.color, orm: сМатериалом ? r.orm : null, transparent: r.transparent,
        })),
        activeVariant: варианты.findIndex((v) => v.id === state.activeVariant),
      });
      continue;
    }
    карты.set(mesh, {
      colorCanvas: t.canvas,
      ormCanvas: hasMaterialPaint(t) ? t.ormCanvas : null,
      transparent: !!mesh.material?.transparent,
    });
  }
  return карты;
}

/**
 * Сохранить наружу. Карты кладут на модель сами; модель с покраской
 * открывается в редакторе уже готовой — это разные потребности, и формат
 * выбирает человек.
 */
async function saveAs(формат) {
  if (!targets.size || !viewport.model) {
    setStatusHint(t('save.nothing'));
    return 0;
  }

  const основа = safeName(имяМодели().replace(/\.[^.]+$/, '') || 'model');

  if (формат === 'png') return saveTextures();
  if (формат === 'project') return saveProject(true);

  const карты = картыДляЭкспорта();

  // В файл — в исходных координатах: поворот модели нужен для работы, а не
  // для чужого пайплайна.
  if (формат === 'glb' || формат === 'gltf') {
    return сохранитьФайлы(основа, 1, async () => [{
      name: `${основа}.${формат}`,
      blob: await viewport.inFileSpace(() => exportGLTF(viewport.model, картыДляЭкспорта(true), формат === 'glb')),
    }], 'busy.save', `${основа}.${формат}`);
  }

  // OBJ — три файла: геометрия, материал и карта. OBJ ссылается на карту по
  // имени, поэтому все три должны лечь рядом — одной папкой.
  return сохранитьФайлы(основа, 3, async () => {
    const { obj, mtl } = await viewport.inFileSpace(() => exportOBJ(viewport.model, карты, основа));
    const [, первая] = [...targets][0];
    return [
      { name: `${основа}.obj`, blob: obj },
      { name: `${основа}.mtl`, blob: mtl },
      { name: `${основа}.png`, blob: await canvasBlob(первая.canvas) },
    ];
  }, 'busy.save', `${основа}.obj`);
}

/** Есть ли на карте материала хоть что-то, кроме подложки. */
function hasMaterialPaint(t) {
  for (let p = 0; p < t.size * t.size; p++) {
    if (t.orm[p * 4 + 2] > 4 || Math.abs(t.orm[p * 4 + 1] - t.bgRough) > 3) return true;
  }
  return false;
}

/**
 * Карты меша: цветовая и, если по ней красили поверхностью, карта материала.
 * Без неё работа по поверхности молча потерялась бы.
 */
function картыМеша(mesh, t, всеВарианты = false) {
  const stem = имяКарты(mesh);
  // С вариантами — по карте на каждый, к имени добавляется имя варианта.
  if (всеВарианты && state.variants.length > 1) {
    const сборки = state.variants.map((v) => ({ v, r: t.renderVariant(v.id) }));
    const сМатериалом = сборки.some(({ r }) => r.materialPaint);
    return сборки.flatMap(({ v, r }) => {
      const имя = `${stem}_${safeName(имяВарианта(v))}`;
      const к = [{ name: `${имя}.png`, canvas: r.color }];
      if (сМатериалом) к.push({ name: `${имя}_material.png`, canvas: r.orm });
      return к;
    });
  }
  const список = [{ name: `${stem}.png`, canvas: t.canvas }];
  if (hasMaterialPaint(t)) список.push({ name: `${stem}_material.png`, canvas: t.ormCanvas });
  return список;
}

/* ── Проект: свой формат со слоями и настройками ───────────────── */

/**
 * Куда сохранён открытый проект. Есть — ⌘S пишет туда же молча, как
 * «Сохранить» в любом редакторе; нет — спрашивает место. Проект, открытый
 * из файла, адреса не даёт (браузер его не раскрывает), поэтому первое
 * сохранение после открытия тоже спрашивает.
 */
let projectHandle = null;

/** Всё, что нужно, чтобы открыть работу ровно такой, какой её оставили. */
async function собратьПроект() {
  const modelGLB = await viewport.inFileSpace(() => exportGeometryGLB(viewport.model));
  const meshes = viewport.paintables.map(({ mesh, cache }) => {
    const tg = targets.get(mesh);
    return { name: mesh.name, triCount: cache.triCount, size: tg.size, activeIndex: tg.activeIndex, layers: tg.layers };
  });
  const meta = {
    name: имяМодели(),
    texSize: state.texSize,
    activeLayer: state.activeLayer,
    pose: viewport.pose(),
    view: viewport.viewState(),
    display: state.unlit ? 'flat' : 'material',
    material: {
      color: state.color, color2: state.color2, roughness: state.roughness,
      metalness: state.metalness, opacity: state.opacity, pattern: state.pattern,
      name: typeof state.matName === 'string' ? state.matName : null,
    },
    brush: { ...state.brush }, sizePct: state.sizePct, frontOnly: state.frontOnly,
    variants: state.variants, activeVariant: state.activeVariant,
  };
  return packProject({ modelGLB, meta, meshes, app: APP_VERSION });
}

/**
 * Сохранить проект. Место спрашивается сразу по нажатию — до сборки под
 * индикатором, иначе браузер уже не даст открыть окно.
 * @param {boolean} какНовый «Сохранить как…»: спросить место заново
 */
async function saveProject(какНовый = false) {
  if (!targets.size || !viewport.model) { setStatusHint(t('save.nothing')); return 0; }
  const имя = `${safeName(имяМодели().replace(/\.[^.]+$/, '') || 'model')}.${PROJECT_EXT}`;
  let место = какНовый ? null : projectHandle;
  if (!место && typeof window.showSaveFilePicker === 'function') {
    try {
      место = await window.showSaveFilePicker({
        suggestedName: имя, id: '3dpainter-project',
        types: [{ description: t('save.projectType'), accept: { 'application/octet-stream': ['.' + PROJECT_EXT] } }],
      });
    } catch (err) {
      if (err?.name === 'AbortError') { setStatusHint(t('save.cancelled')); return 0; }
      console.warn(err);
      место = null;                     // не вышло — отдадим обычным скачиванием
    }
  }
  return withBusy('busy.project', async () => {
    try {
      const blob = new Blob([await собратьПроект()], { type: 'application/octet-stream' });
      if (место) {
        const поток = await место.createWritable();
        await поток.write(blob);
        await поток.close();
        projectHandle = место;
      } else {
        downloadBlob(blob, имя);
      }
      setStatusHint(t('project.saved', место?.name || имя, UI.formatBytes(blob.size)));
      return 1;
    } catch (err) {
      setStatusHint(t('save.failed', err.message));
      console.error(err);
      return 0;
    }
  }, имя);
}

/**
 * Открыть проект: модель, слои, свойства слоёв, положение, ракурс, материал
 * и кисть — всё как при сохранении.
 */
async function openProject(buffer, fileName) {
  setStatusHint(t('load.loading', fileName));
  return withBusy('busy.open', async () => {
    try {
      const { meta, modelGLB, file } = unpackProject(buffer);
      busyNote('busy.prepare');
      const glb = modelGLB.buffer.slice(modelGLB.byteOffset, modelGLB.byteOffset + modelGLB.byteLength);
      const report = await viewport.loadFile(glb, 'model.glb');
      report.name = meta.name || fileName;
      // Размер карт — как при сохранении: слои лежат в нём байт в байт.
      if (meta.texSize) state.texSize = meta.texSize;
      afterModelLoaded(report, recentId(fileName, buffer.byteLength));

      // Слои — по мешам в порядке обхода. Геометрия своя, из проекта, поэтому
      // порядок и число треугольников обязаны совпасть; не совпали — значит,
      // файл повреждён, и класть краску наугад нельзя.
      const пары = viewport.paintables;
      if (пары.length !== meta.meshes.length) throw new Error(t('project.mismatch'));
      пары.forEach(({ mesh, cache }, i) => {
        const м = meta.meshes[i];
        const tg = targets.get(mesh);
        if (!tg || tg.size !== м.size || cache.triCount !== м.triCount) throw new Error(t('project.mismatch'));
        tg.layers = м.layers.map((L) => {
          const слой = new Layer(tg.size, L.name, L.auto);
          слой.visible = L.visible; слой.opacity = L.opacity; слой.blend = L.blend;
          слой.variant = L.variant ?? null;
          for (const [ключ, путь] of Object.entries(L.files)) {
            const байты = file(путь);
            if (!байты) continue;
            if (ключ === 'mask') слой.ensureMask(tg.size);
            слой[ключ].set(байты);
          }
          return слой;
        });
        tg.activeIndex = Math.min(м.activeIndex ?? 0, tg.layers.length - 1);
        tg.variant = meta.activeVariant ?? null;
        tg.compositeRect(null);
      });
      state.activeLayer = Math.min(meta.activeLayer ?? 0, (пары.length ? targets.get(пары[0].mesh).layers.length : 1) - 1);
      state.variants = Array.isArray(meta.variants) ? meta.variants : [];
      state.activeVariant = state.variants.length ? (meta.activeVariant ?? state.variants[0].id) : null;
      state.nextVariant = state.variants.reduce((n, v) => Math.max(n, v.id + 1), 1);
      поправитьАктивныйСлой();

      if (meta.pose) { viewport.setPose(meta.pose); savePose(meta.pose); }
      viewport.setViewState(meta.view);
      if (meta.display) setUnlit(meta.display === 'flat');
      if (meta.material) {
        const { name, ...остальное } = meta.material;
        setMaterial({ ...остальное, name: name || (() => t('mat.paint')) });
      }
      if (meta.brush) state.brush = { ...state.brush, ...meta.brush };
      if (meta.sizePct) state.sizePct = meta.sizePct;
      if (typeof meta.frontOnly === 'boolean') { state.frontOnly = meta.frontOnly; $('brush-frontface').checked = meta.frontOnly; }

      viewport.syncTransparency();
      syncBrushLabels(); syncVariants(); syncLayers(); syncPoseUI(); syncViewUI();
      drawUVRows(); refreshUV();
      history.clear(); renderHistory(); syncHistoryButtons();
      state.painted = false;
      projectHandle = null;
      welcome.hide();
      setStatusHint(t('project.opened', fileName));
      await rememberRecent(fileName, buffer);
      rememberThumb(fileName, buffer.byteLength);
      return true;
    } catch (err) {
      setStatusHint(t('load.failed', fileName, err.message));
      console.error(err);
      return false;
    }
  }, fileName);
}

/** Все карты всех мешей — одной папкой, если их больше одной. */
async function saveTextures() {
  if (!targets.size) return 0;
  const base = safeName(имяМодели().replace(/\.[^.]+$/, '') || 'model');
  const все = [...targets].flatMap(([mesh, t]) => картыМеша(mesh, t, true));
  return сохранитьФайлы(`${base} — карты`, все.length,
    async () => Promise.all(все.map(async (к) => ({ name: к.name, blob: await canvasBlob(к.canvas) }))),
    'busy.maps');
}

/** Имя файла для карт меша: у составной модели к имени модели — имя меша. */
function имяКарты(mesh) {
  const base = safeName(имяМодели().replace(/\.[^.]+$/, '') || 'model');
  if (targets.size <= 1) return base;
  const i = [...targets.keys()].indexOf(mesh);
  return safeName(`${base}_${mesh.name || 'mesh' + i}`);
}

/**
 * Сохранить выделенную развёртку: её цветовую карту, а если по ней красили
 * поверхностью — и карту материала рядом, как и при полной выгрузке.
 */
function saveUVPng() {
  const target = activeTarget();
  if (!state.uvOpen || !target) return;
  const карты = картыМеша(activeMesh, target);
  return сохранитьФайлы(имяКарты(activeMesh), карты.length,
    async () => Promise.all(карты.map(async (к) => ({ name: к.name, blob: await canvasBlob(к.canvas) }))),
    'busy.maps');
}
$('btn-uv-png').addEventListener('click', saveUVPng);
$('btn-uv-rebuild').addEventListener('click', rebuildOverlappingUV);

const aboutModal = createAboutModal({ version: APP_VERSION, icon: значокПрограммы });

/* «Вид в PNG» — снимок модели в текущем ракурсе на прозрачном фоне. */
const viewPngModal = createViewPngModal({
  viewSize: () => viewport.viewSize(),
  maxSide: () => viewport.maxRenderSide(),
  save: ({ w, h, ss }) => withBusy('busy.view', () => new Promise((готово) => {
    const картинка = viewport.renderView(w, h, ss);
    const холст = document.createElement('canvas');
    холст.width = w; холст.height = h;
    холст.getContext('2d').putImageData(картинка, 0, 0);
    холст.toBlob((blob) => {
      const base = safeName(имяМодели().replace(/\.[^.]+$/, '') || 'model');
      if (blob) downloadBlob(blob, `${base}_view.png`);
      setStatusHint(t('status.viewSaved', w, h));
      готово();
    }, 'image/png');
  }), w, h),
});
$('btn-view-png').addEventListener('click', () => {
  if (!targets.size) { setStatusHint(t('status.noModel')); return; }
  viewPngModal.open();
});

/* ── Клавиатура ────────────────────────────────────────────────── */

const TOOL_KEYS = { l: 'lasso', v: 'select', h: 'pan', o: 'orbit', z: 'zoom', b: 'brush', e: 'eraser', i: 'eyedropper', f: 'fill-faces', g: 'fill-island', r: 'rect', c: 'ellipse', t: 'text', a: 'decal' };
const VIEW_KEYS = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 6: 'top', 7: 'bottom', 0: 'user' };

/**
 * Печатает ли человек текст — тогда клавиши его, а не инструмента.
 * 🔴 Ползунок, галка и кнопка фокус держат, но текста в них нет: раньше
 * после любого ползунка молчали ⌘Z и все клавиши инструментов — событие
 * доходило до страницы, а обработчик его пропускал.
 */
const NOT_TEXT = new Set(['range', 'checkbox', 'radio', 'button', 'color', 'file', 'submit', 'reset']);
function typingInto(el, e) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return !NOT_TEXT.has(el.type);
  // В списке буквы листают пункты, а сочетания с ⌘ ему не нужны.
  if (el.tagName === 'SELECT') return !(e.metaKey || e.ctrlKey);
  return false;
}

window.addEventListener('keydown', (e) => {
  if (typingInto(e.target, e)) return;

  // Пробел — временный режим перемещения, как принято в графических пакетах.
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; uvEditor.spaceDown = true; viewport.setLeftButtonPan(true); }
    return;
  }

  // Выделение — те же сочетания, что в Photoshop.
  if (e.metaKey || e.ctrlKey) {
    const kk = e.key.toLowerCase();
    if (kk === 's') { e.preventDefault(); saveProject(e.shiftKey); return; }
    if (kk === 'a' && !e.shiftKey) { e.preventDefault(); selectAll(); return; }
    if (kk === 'd' && !e.shiftKey) { e.preventDefault(); clearSelection(); return; }
    if (kk === 'i' && e.shiftKey) { e.preventDefault(); invertSelection(); return; }
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && lassoKey(e.key)) { e.preventDefault(); return; }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && decal.quad && state.tool === 'decal') {
    if (e.key === 'Enter') { e.preventDefault(); applyDecal(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelDecal(); return; }
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
  // L переключает вольное лассо и лассо по точкам — как Shift+L в Photoshop.
  if (k === 'l' && state.tool === 'lasso') { setTool('lasso-poly'); return; }
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
  // 🔴 Не просто выключаем: у инструмента сдвига левая кнопка так и должна
  // остаться сдвигом. Пробел его лишь временно повторяет.
  viewport.setLeftButtonPan(state.tool === 'pan');
};
window.addEventListener('keyup', (e) => { if (e.code === 'Space') releaseSpace(); });
window.addEventListener('blur', releaseSpace);

/* ── Меню программы ────────────────────────────────────────────── */

const MOD = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+';

const menuBar = new MenuBar($('menubar'), [
  { title: () => t('menu.file'), items: [
    { label: () => t('file.start'), action: () => welcome.show() },
    '-',
    { label: () => t('file.open'), action: () => $('file-input').click() },
    { label: () => t('file.demo'), action: () => afterModelLoaded(viewport.loadDemo()) },
    '-',
    { label: () => t('file.saveProject'), hint: MOD + 'S', disabled: () => !targets.size, action: () => saveProject(false) },
    { label: () => t('file.saveProjectAs'), hint: '⇧' + MOD + 'S', disabled: () => !targets.size, action: () => saveProject(true) },
    '-',
    { label: () => t('file.saveAs'), disabled: () => !targets.size, action: () => saveAsModal.open() },
    { label: () => t('file.savePng'), disabled: () => !targets.size, action: saveTextures },
    '-',
    { label: () => `${t('file.texSize')}: 512`, radio: () => state.texSize === 512, action: () => setTexSize(512) },
    { label: () => `${t('file.texSize')}: 1024`, radio: () => state.texSize === 1024, action: () => setTexSize(1024) },
    { label: () => `${t('file.texSize')}: 2048`, radio: () => state.texSize === 2048, action: () => setTexSize(2048) },
    '-',
    { label: () => t('file.settings'), action: () => settingsModal.open() },
  ] },

  { title: () => t('menu.edit'), items: [
    { label: () => t('edit.undo'), hint: MOD + 'Z', disabled: () => !history.canUndo, action: () => history.undo() },
    { label: () => t('edit.redo'), hint: '⇧' + MOD + 'Z', disabled: () => !history.canRedo, action: () => history.redo() },
    '-',
    { label: () => t('edit.toStart'), disabled: () => !history.canUndo, action: () => history.goto(-1) },
    { label: () => t('edit.toEnd'), disabled: () => !history.canRedo, action: () => history.goto(history.entries.length - 1) },
  ] },

  { title: () => t('menu.select'), items: [
    { label: () => t('select.all'), hint: MOD + 'A', disabled: () => !targets.size, action: selectAll },
    { label: () => t('select.none'), hint: MOD + 'D', disabled: () => !hasSelection(), action: clearSelection },
    { label: () => t('select.invert'), hint: '⇧' + MOD + 'I', disabled: () => !hasSelection(), action: invertSelection },
  ] },

  { title: () => t('menu.layer'), items: [
    { label: () => t('layer.new'), action: addLayer },
    { label: () => t('layer.remove'), disabled: () => (refLayers()?.length ?? 0) <= 1, action: removeLayer },
    '-',
    { label: () => t('layer.blend.normal'), radio: () => currentBlend() === 'normal', action: () => setBlend('normal') },
    { label: () => t('layer.blend.multiply'), radio: () => currentBlend() === 'multiply', action: () => setBlend('multiply') },
    { label: () => t('layer.blend.screen'), radio: () => currentBlend() === 'screen', action: () => setBlend('screen') },
  ] },

  { title: () => t('menu.view'), items: [
    { label: () => t('view.front'), hint: '1', radio: () => viewport.currentViewName() === 'front', action: () => applyView('front') },
    { label: () => t('view.back'), hint: '2', radio: () => viewport.currentViewName() === 'back', action: () => applyView('back') },
    { label: () => t('view.left'), hint: '3', radio: () => viewport.currentViewName() === 'left', action: () => applyView('left') },
    { label: () => t('view.right'), hint: '4', radio: () => viewport.currentViewName() === 'right', action: () => applyView('right') },
    { label: () => t('view.top'), hint: '6', radio: () => viewport.currentViewName() === 'top', action: () => applyView('top') },
    { label: () => t('view.bottom'), hint: '7', radio: () => viewport.currentViewName() === 'bottom', action: () => applyView('bottom') },
    { label: () => t('view.user'), hint: '0', action: () => applyView('user') },
    '-',
    { label: () => t('view.ortho'), hint: '5', checked: () => viewport.projection === 'ortho',
      action: () => setProjection(viewport.projection === 'ortho' ? 'persp' : 'ortho') },
    { label: () => t('view.fit'), hint: 'Home', action: () => viewport.centerCamera() },
    '-',
    { label: () => t('pose.front'), disabled: () => !viewport.model, action: () => applyPose('front') },
    { label: () => t('pose.up'), disabled: () => !viewport.model, action: () => applyPose('up') },
    { label: () => t('pose.left'), disabled: () => !viewport.model, action: () => applyPose('left') },
    { label: () => t('pose.right'), disabled: () => !viewport.model, action: () => applyPose('right') },
    { label: () => t('pose.reset'), disabled: () => !viewport.model, action: () => applyPose('reset') },
    '-',
    { label: () => t('view.pivot.world'), radio: () => state.pivot === 'world', action: () => setPivot('world') },
    { label: () => t('view.pivot.local'), radio: () => state.pivot === 'local', action: () => setPivot('local') },
    { label: () => t('view.pivot.camera'), radio: () => state.pivot === 'camera', action: () => setPivot('camera') },
    '-',
    { label: () => t('vm.material'), radio: () => state.viewMode === 'material', action: () => setViewMode('material') },
    { label: () => t('vm.clay'), radio: () => state.viewMode === 'clay', action: () => setViewMode('clay') },
    { label: () => t('vm.wire'), radio: () => state.viewMode === 'wire', action: () => setViewMode('wire') },
    { label: () => t('vm.normals'), radio: () => state.viewMode === 'normals', action: () => setViewMode('normals') },
    '-',
    { label: () => t('vm.facets'), checked: () => state.facets, action: () => setFacets(!state.facets) },
    { label: () => t('light.unlit'), checked: () => state.unlit, action: () => setUnlit(!state.unlit) },
    { label: () => t('light.spin'), checked: () => viewport.spin, action: () => setSpin(!viewport.spin) },
    { label: () => t('view.grid'), checked: () => state.grid, action: () => setGrid(!state.grid) },
  ] },

  { title: () => t('menu.tool'), items: [
    { label: () => t('tool.brush'), hint: 'B', radio: () => state.tool === 'brush', action: () => setTool('brush') },
    { label: () => t('tool.eraser'), hint: 'E', radio: () => state.tool === 'eraser', action: () => setTool('eraser') },
    { label: () => t('tool.eyedropper'), hint: 'I', radio: () => state.tool === 'eyedropper', action: () => setTool('eyedropper') },
    '-',
    { label: () => t('tool.select'), hint: 'V', radio: () => state.tool === 'select', action: () => setTool('select') },
    '-',
    { label: () => t('tool.pan'), hint: 'H', radio: () => state.tool === 'pan', action: () => setTool('pan') },
    { label: () => t('tool.orbit'), hint: 'O', radio: () => state.tool === 'orbit', action: () => setTool('orbit') },
    { label: () => t('tool.zoom'), hint: 'Z', radio: () => state.tool === 'zoom', action: () => setTool('zoom') },
    '-',
    { label: () => t('tool.fillFaces'), hint: 'F', radio: () => state.tool === 'fill-faces', action: () => setTool('fill-faces') },
    { label: () => t('tool.fillIsland'), hint: 'G', radio: () => state.tool === 'fill-island', action: () => setTool('fill-island') },
    { label: () => t('tool.fillLayer'), radio: () => state.tool === 'fill-layer', action: () => setTool('fill-layer') },
    '-',
    { label: () => t('tool.lasso'), hint: 'L', radio: () => state.tool === 'lasso', action: () => setTool('lasso') },
    { label: () => t('tool.lassoPoly'), hint: 'L L', radio: () => state.tool === 'lasso-poly', action: () => setTool('lasso-poly') },
    '-',
    { label: () => t('tool.rect'), hint: 'R', radio: () => state.tool === 'rect', action: () => setTool('rect') },
    { label: () => t('tool.ellipse'), hint: 'C', radio: () => state.tool === 'ellipse', action: () => setTool('ellipse') },
    { label: () => t('tool.text'), hint: 'T', radio: () => state.tool === 'text', action: () => setTool('text') },
    { label: () => t('tool.decal'), hint: 'A', radio: () => state.tool === 'decal', action: () => setTool('decal') },
    '-',
    { label: () => t('tool.brushes'), action: () => brushModal.open() },
    { label: () => t('tool.materials'), action: () => materialModal.open() },
  ] },

  { title: () => t('menu.effects'), items: [
    { label: () => t('fx.pixel'), checked: () => viewport.pixelArt.enabled,
      action: () => setEffect('pixelArt', { enabled: !viewport.pixelArt.enabled }) },
    { label: () => t('fx.pixelSettings'), action: () => EFFECTS.pixelArt.modal.open() },
    '-',
    { label: () => t('fx.anime'), checked: () => viewport.anime.enabled,
      action: () => setEffect('anime', { enabled: !viewport.anime.enabled }) },
    { label: () => t('fx.animeSettings'), action: () => EFFECTS.anime.modal.open() },
  ] },

  { title: () => t('menu.panels'), items: [
    { label: () => t('panels.uv'), hint: 'U', checked: () => state.uvOpen, action: () => setUVOpen(!state.uvOpen) },
    { label: () => t('panels.uvWire'), checked: () => state.showWire, action: () => setShowWire(!state.showWire) },
    '-',
    { label: () => t('panels.tools'), checked: () => !app.classList.contains('no-tools'),
      action: () => togglePanel('no-tools', $('btn-tools-toggle')) },
    { label: () => t('panels.side'), checked: () => !app.classList.contains('no-side'),
      action: () => togglePanel('no-side', $('btn-side-toggle')) },
    { label: () => t('panels.hideAll'), hint: 'Tab', action: toggleAllPanels },
  ] },

  { title: () => t('menu.help'), items: [
    { label: () => t('help.keys'), hint: 'F1', action: () => helpModal.open() },
    '-',
    { label: () => t('about.menu'), action: () => aboutModal.open() },
  ] },
]);

/**
 * Смена языка на лету. Меню и разметка перечитывают ключи, а всё, что
 * собрано из строк в коде — подписи кисти, имя материала, слои, история,
 * строка состояния, — пересчитывается заново. Покраска при этом остаётся:
 * ради переключения языка терять работу незачем.
 */
onLangChange(() => {
  menuBar.relabel();
  applyDOM();

  syncBrushLabels();
  syncMaterialChip();
  syncVariants();      // автоимена «Вариант N» переводятся вместе с интерфейсом
  syncLayers();
  renderHistory();
  syncStatusModel();
  syncPerf();
  syncShapeUI();
  syncDecalUI();
  syncStatusCounts();
  syncModelNotes();
  syncModelInfo();
  // Список развёрток строится кодом: «N трис» на вчерашнем языке остался бы
  // висеть, пока не откроют другую модель.
  renderUVList();
  document.querySelector('#statusbar .hint').textContent = HINT();
});

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

setMaterial({ color: state.color, name: () => t('mat.paint') });
syncShapeUI();
setTool('brush');
setProjection('persp');
setGrid(true);
{
  const p = loadPrefs();
  state.facets = !!p.facets;
  if (p.light) Object.assign(state.light, p.light);
  viewport.setLight(state.light);
}
applyShading();
afterModelLoaded(viewport.loadDemo());
setPivot(loadPrefs().pivot || 'local');
syncViewUI();

// Перевести разметку и принимать все форматы, которые умеем читать.
applyDOM();
syncStatusModel();   // applyDOM() прошёл по разметке — вернуть имя модели на место
$('file-input').accept = acceptAttribute() + ',.' + PROJECT_EXT;

// Начальный экран — поверх готовой программы: под ним уже стоит демо-модель,
// поэтому закрыть его можно в любой момент и сразу красить.
if (loadPrefs().showWelcome !== false) welcome.show();

// Доступ из консоли браузера — чтобы проверять инструмент вручную и видеть,
// куда попадает луч, не угадывая координаты по скриншоту.
window.__paint = { viewport, uvEditor, viewCube, menuBar, brushModal, materialModal, helpModal,
  saveAsModal, settingsModal, welcome, targets, state, history,
  setTool, setColor, setMaterial, setLang, getLang, saveAs, openBuffer, openFile, bootErrors, decal,
  // Для проверок (`tests/`): тот же путь, что «Сохранить как ▸ GLB», без окна сохранения.
  exportGLB: () => viewport.inFileSpace(() => exportGLTF(viewport.model, картыДляЭкспорта(true), true)),
  projectBytes: () => собратьПроект(),
  addVariant, включитьВариант, toggleLayerVariant };

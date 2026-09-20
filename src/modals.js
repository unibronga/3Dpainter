/**
 * Модальные окна: расширенный выбор кисти и выбор материала с цветом.
 *
 * В боковой панели остаётся только то, что нужно каждую минуту (размер,
 * жёсткость, нажим, текущий цвет). Всё остальное — библиотека кистей, зерно и
 * разброс, подбор цвета и библиотека материалов — живёт здесь: иначе панель
 * растёт до нечитаемости.
 */

import { drawBrushSample } from './painter.js';
import { drawMaterialBall } from './matball.js';
import { PATTERNS, drawPatternSample } from './patterns.js';
import { PALETTE } from './ui.js';
import { rgbToHex, hexToRgb } from './ui.js';
import { t, onLangChange, LANGS } from './i18n.js';

/* ── Библиотека кистей ─────────────────────────────────────────── */

export const BRUSH_PRESETS = [
  { name: 'Жёсткая круглая', brush: { hardness: 1, flow: 1, grain: 0, shape: 'round', spacing: 0.25, scatter: 0 } },
  { name: 'Мягкая круглая', brush: { hardness: 0.15, flow: 1, grain: 0, shape: 'round', spacing: 0.2, scatter: 0 } },
  { name: 'Маркер', brush: { hardness: 0.9, flow: 0.85, grain: 0, shape: 'round', spacing: 0.12, scatter: 0 } },
  { name: 'Тушь', brush: { hardness: 1, flow: 1, grain: 0, shape: 'round', spacing: 0.05, scatter: 0 } },
  { name: 'Карандаш', brush: { hardness: 0.95, flow: 0.55, grain: 0.3, shape: 'round', spacing: 0.08, scatter: 0.03 } },
  { name: 'Аэрограф', brush: { hardness: 0, flow: 0.22, grain: 0, shape: 'round', spacing: 0.06, scatter: 0 } },
  { name: 'Пастель', brush: { hardness: 0.5, flow: 0.9, grain: 0.5, shape: 'round', spacing: 0.18, scatter: 0.06 } },
  { name: 'Сухая кисть', brush: { hardness: 0.6, flow: 0.95, grain: 0.7, shape: 'round', spacing: 0.3, scatter: 0.12 } },
  { name: 'Мел', brush: { hardness: 0.35, flow: 1, grain: 0.85, shape: 'round', spacing: 0.22, scatter: 0.05 } },
  { name: 'Губка', brush: { hardness: 0.25, flow: 0.7, grain: 0.9, shape: 'round', spacing: 0.45, scatter: 0.4 } },
  { name: 'Брызги', brush: { hardness: 0.5, flow: 0.8, grain: 0.55, shape: 'round', spacing: 0.6, scatter: 0.7 } },
  { name: 'Царапины', brush: { hardness: 1, flow: 0.9, grain: 0.8, shape: 'round', spacing: 0.75, scatter: 0.85 } },
  { name: 'Квадратная', brush: { hardness: 1, flow: 1, grain: 0, shape: 'square', spacing: 0.3, scatter: 0 } },
  { name: 'Плоский резец', brush: { hardness: 0.85, flow: 1, grain: 0.15, shape: 'square', spacing: 0.15, scatter: 0 } },
  { name: 'Мягкий квадрат', brush: { hardness: 0.25, flow: 1, grain: 0, shape: 'square', spacing: 0.2, scatter: 0 } },
  { name: 'Штукатурка', brush: { hardness: 0.7, flow: 1, grain: 0.6, shape: 'square', spacing: 0.5, scatter: 0.45 } },
];

const BRUSH_KEYS = ['hardness', 'flow', 'grain', 'shape', 'spacing', 'scatter'];

/* ── Библиотека материалов ─────────────────────────────────────── */

/**
 * У группы своя поверхность: дерево матовое, металл гладкий и отражающий,
 * вода почти зеркальная. Выбор материала ставит и цвет, и поверхность —
 * иначе шар в библиотеке обещал бы одно, а модель показывала другое.
 */
export const MATERIAL_GROUPS = [
  // Обычная краска: ни узора, ни блеска — просто цвет. Самый частый случай,
  // поэтому стоит первым.
  { name: 'Краска', roughness: 0.9, metalness: 0, colors: PALETTE },

  { name: 'Дерево', roughness: 0.95, metalness: 0, pattern: { id: 'wood', scale: 9, contrast: 1.2 },
    colors: ['#9b7653', '#6b4f3a', '#c8a074', '#4a3728', '#b98c5a', '#7d5d42'] },
  { name: 'Камень', roughness: 0.92, metalness: 0, pattern: { id: 'stone', scale: 7, contrast: 1.1 },
    colors: ['#a8a49b', '#6e6a63', '#d9d4c7', '#4a4844', '#8d9096', '#5d5f63'] },
  { name: 'Кладка', roughness: 0.95, metalness: 0, pattern: { id: 'brick', scale: 5, contrast: 1.4 },
    colors: ['#b0563c', '#8d4a36', '#c98f6b', '#6d6a66', '#a89880', '#7a3f2e'] },
  { name: 'Металл', roughness: 0.3, metalness: 1, pattern: { id: 'scratch', scale: 8, contrast: 1 },
    colors: ['#b9bec6', '#7d848d', '#565c66', '#c9a227', '#b87333', '#3f444b'] },
  { name: 'Зелень', roughness: 1, metalness: 0, pattern: { id: 'grass', scale: 9, contrast: 1.2 },
    colors: ['#8fae5a', '#4f7a4b', '#2f5d50', '#b5c96a', '#35553a', '#6d9150'] },
  { name: 'Земля', roughness: 1, metalness: 0, pattern: { id: 'noise', scale: 9, contrast: 0.8 },
    colors: ['#b08050', '#8a5e3c', '#d9b483', '#5e4530', '#c99a6b', '#6f4e33'] },
  { name: 'Вода', roughness: 0.1, metalness: 0, opacity: 0.8,
    colors: ['#56809e', '#2f4858', '#7fb0c4', '#1e3644', '#9fd0d9', '#3d6b83'] },
  { name: 'Ткань', roughness: 1, metalness: 0, pattern: { id: 'noise', scale: 14, contrast: 0.5 },
    colors: ['#c8563c', '#e0a355', '#f2d6a2', '#7a4b6b', '#3c4a6b', '#a33f2e'] },
  { name: 'Стекло', roughness: 0.06, metalness: 0, opacity: 0.25,
    colors: ['#cfe3e8', '#9fc2cc', '#6f97a4', '#d6c9e0', '#b7d6b2', '#e8e4dc'] },
  { name: 'Ржавчина', roughness: 0.85, metalness: 0.35, pattern: { id: 'rust', scale: 8, contrast: 1.3 },
    colors: ['#8a4b2a', '#6d3a20', '#a86336', '#4f2e1c', '#93664a', '#5c4534'] },
  { name: 'Свет и тень', roughness: 0.85, metalness: 0,
    colors: ['#ffffff', '#e8e4dc', '#a09c94', '#3c3a37', '#1e1c1a', '#ffd9a0'] },
];

/** Материал из группы и цвета — с узором, поверхностью и прозрачностью. */
export function materialFrom(group, hex) {
  const color = hexToRgb(hex);
  return {
    color,
    // Второй цвет узора — затемнение основного: так узор читается на любом
    // цвете и не требует ручной настройки на каждый материал.
    color2: color.map((v) => Math.round(v * 0.55)),
    pattern: group.pattern ? { ...group.pattern } : { id: 'none', scale: 8, contrast: 1 },
    roughness: group.roughness,
    metalness: group.metalness,
    opacity: group.opacity ?? 1,
    name: `${group.name} · ${hex.toUpperCase()}`,
  };
}

/** Поверхность — только для показа: в выдачу материалы идут плоскими. */
export const SURFACES = [
  { name: 'Матовая', roughness: 1.0, metalness: 0 },
  { name: 'Обычная', roughness: 0.9, metalness: 0 },
  { name: 'Гладкая', roughness: 0.45, metalness: 0 },
  { name: 'Металл', roughness: 0.3, metalness: 1 },
];

/* ── Преобразования цвета ──────────────────────────────────────── */

export function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return t.map((k) => Math.round((k + m) * 255));
}

/** Ряд оттенков одного цвета: от тени к свету. Основа зонирования low-poly. */
export function shadesOf(rgb) {
  const [h, s, v] = rgbToHsv(rgb);
  const steps = [0.35, 0.52, 0.7, 0.85, 1, 1.12, 1.26, 1.45];
  return steps.map((k) => {
    const nv = Math.max(0.02, Math.min(1, v * k));
    // К свету цвет чуть блёкнет, к тени — насыщается: так работает глаз.
    const ns = Math.max(0, Math.min(1, s * (k > 1 ? 1 - (k - 1) * 0.5 : 1 + (1 - k) * 0.25)));
    return hsvToRgb(h, ns, nv);
  });
}

/* ── Оболочка окна ─────────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

class Modal {
  constructor(title, cls = '') {
    this.back = el('div', 'modal-back');
    this.box = el('div', 'modal ' + cls);

    const head = el('div', 'modal-head');
    head.appendChild(el('span', 't', title));
    const x = el('button', 'modal-x', '×');
    x.title = 'Закрыть без изменений (Esc)';
    x.addEventListener('click', () => this.cancel());
    head.appendChild(x);

    this.body = el('div', 'modal-body');
    this.box.append(head, this.body);

    this.foot = el('div', 'modal-foot');
    this.box.appendChild(this.foot);

    this.back.appendChild(this.box);
    document.body.appendChild(this.back);

    this.back.addEventListener('pointerdown', (e) => { if (e.target === this.back) this.cancel(); });
  }

  /** Закрытие «мимо окна» и Esc считаются отказом, а не подтверждением. */
  cancel() {
    if (this.onCancel) this.onCancel();
    this.close();
  }

  open() {
    this.back.classList.add('open');
    if (this.onOpen) this.onOpen();
    Modal.current = this;
  }

  close() {
    this.back.classList.remove('open');
    if (Modal.current === this) Modal.current = null;
  }
}
Modal.current = null;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && Modal.current) Modal.current.cancel();
});

/* ── Ряд с ползунком ───────────────────────────────────────────── */

function slider(parent, label, min, max, step, get, set, fmt) {
  const row = el('div', 'row');
  row.appendChild(el('label', null, label));
  const inp = el('input');
  inp.type = 'range';
  inp.min = min; inp.max = max; inp.step = step;
  const val = el('span', 'val');
  row.append(inp, val);
  parent.appendChild(row);

  const sync = () => { inp.value = get(); val.textContent = fmt(get()); };
  inp.addEventListener('input', () => { set(+inp.value); val.textContent = fmt(+inp.value); });
  sync();
  return sync;
}

/* ── Окно кистей ───────────────────────────────────────────────── */

export function createBrushModal(api) {
  const m = new Modal('Кисти', 'wide');

  const preview = el('canvas', 'brush-preview');
  preview.width = 600; preview.height = 96;
  m.body.appendChild(preview);

  m.body.appendChild(el('div', 'modal-sub', 'Готовые кисти'));
  const grid = el('div', 'brush-grid');
  m.body.appendChild(grid);

  const cards = BRUSH_PRESETS.map((p) => {
    const card = el('button', 'brush-card');
    const c = el('canvas');
    c.width = 150; c.height = 46;
    card.append(c, el('span', 'n', p.name));
    card.addEventListener('click', () => { api.setBrush({ ...p.brush }); refresh(); });
    grid.appendChild(card);
    return { card, canvas: c, preset: p };
  });

  m.body.appendChild(el('div', 'modal-sub', 'Настройки'));
  const opts = el('div', 'modal-grid2');
  m.body.appendChild(opts);
  const colA = el('div'); const colB = el('div');
  opts.append(colA, colB);

  const b = () => api.getBrush();

  /**
   * Перерисовать образец сверху и подсветку карточек, не трогая сами
   * ползунки: их сейчас тянет рука, дёргать их значения нельзя.
   */
  function redraw() {
    drawBrushSample(preview, b(), api.getColor());
    markCards();
  }

  const tweak = (patch) => { api.setBrush(patch); redraw(); };

  const syncs = [];
  syncs.push(slider(colA, 'Размер', 0.3, 40, 0.1, api.getSizePct, (v) => { api.setSizePct(v); redraw(); }, (v) => api.sizeLabel(v)));
  syncs.push(slider(colA, 'Жёсткость', 0, 100, 1, () => Math.round(b().hardness * 100), (v) => tweak({ hardness: v / 100 }), (v) => v + '%'));
  syncs.push(slider(colA, 'Нажим', 1, 100, 1, () => Math.round(b().flow * 100), (v) => tweak({ flow: v / 100 }), (v) => v + '%'));
  syncs.push(slider(colB, 'Зерно', 0, 100, 1, () => Math.round((b().grain || 0) * 100), (v) => tweak({ grain: v / 100 }), (v) => v + '%'));
  syncs.push(slider(colB, 'Интервал', 3, 80, 1, () => Math.round((b().spacing ?? 0.25) * 100), (v) => tweak({ spacing: v / 100 }), (v) => v + '%'));
  syncs.push(slider(colB, 'Разброс', 0, 100, 1, () => Math.round((b().scatter || 0) * 100), (v) => tweak({ scatter: v / 100 }), (v) => v + '%'));

  const shapeRow = el('div', 'row wide');
  shapeRow.appendChild(el('label', null, 'Форма'));
  const shapeBox = el('div', 'seg');
  const shapeBtns = [['round', 'круг'], ['square', 'квадрат']].map(([id, name]) => {
    const btn = el('button', 'btn', name);
    btn.addEventListener('click', () => { tweak({ shape: id }); syncShape(); });
    shapeBox.appendChild(btn);
    return { btn, id };
  });
  shapeRow.appendChild(shapeBox);
  opts.appendChild(shapeRow);

  const syncShape = () => shapeBtns.forEach(({ btn, id }) => btn.classList.toggle('on', (b().shape || 'round') === id));

  function markCards() {
    const cur = b();
    for (const { card, preset } of cards) {
      card.classList.toggle('active', BRUSH_KEYS.every((k) => (preset.brush[k] ?? 0) === (cur[k] ?? 0)));
    }
  }

  function refresh() {
    const color = api.getColor();
    for (const { canvas, preset } of cards) drawBrushSample(canvas, preset.brush, color);
    redraw();
    syncShape();
    syncs.forEach((s) => s());
    if (api.onChange) api.onChange();
  }

  m.onOpen = refresh;
  return { open: () => m.open(), refresh, modal: m };
}

/* ── Окно материалов ───────────────────────────────────────────── */

/**
 * @param {object} api
 *   getMaterial() -> {color, alpha, roughness, metalness, name}
 *   setMaterial(patch)
 */
export function createMaterialModal(api) {
  const m = new Modal('Материал', 'xwide');
  let snapshot = null;   // состояние на момент открытия — для «Отмены»

  const cols = el('div', 'mat-cols');
  m.body.appendChild(cols);

  /* ── Колонка 1: подбор цвета ─────────────────────────────── */
  const colPick = el('div', 'mat-col');
  colPick.appendChild(el('div', 'modal-sub', 'Цвет'));

  const pick = el('div', 'picker');
  const sv = el('canvas', 'picker-sv');
  sv.width = 236; sv.height = 190;
  const hue = el('canvas', 'picker-hue');
  hue.width = 22; hue.height = 190;
  pick.append(sv, hue);
  colPick.appendChild(pick);

  const hex = el('input', 'hex');
  hex.spellcheck = false;
  colPick.appendChild(hex);

  colPick.appendChild(el('div', 'modal-sub', 'Оттенки'));
  const shadeRow = el('div', 'shade-row');
  colPick.appendChild(shadeRow);

  /* ── Колонка 2: что получилось ───────────────────────────── */
  const colMat = el('div', 'mat-col');
  colMat.appendChild(el('div', 'modal-sub', 'Чем красим'));

  const bigBall = el('canvas', 'mat-big');
  bigBall.width = 180; bigBall.height = 180;
  colMat.appendChild(bigBall);

  const matName = el('div', 'mat-current-name', 'Краска');
  colMat.appendChild(matName);

  colMat.appendChild(el('div', 'modal-sub', 'Поверхность'));
  const surf = el('div', 'seg-grid');
  const surfBtns = SURFACES.map((sp) => {
    const btn = el('button', 'btn', sp.name);
    btn.addEventListener('click', () => {
      api.setMaterial({ roughness: sp.roughness, metalness: sp.metalness });
      refreshSurface();
    });
    surf.appendChild(btn);
    return { btn, sp };
  });
  colMat.appendChild(surf);

  const surfOpts = el('div');
  colMat.appendChild(surfOpts);
  const syncRough = slider(surfOpts, 'Шерохов.', 0, 100, 1,
    () => Math.round(api.getMaterial().roughness * 100),
    (v) => { api.setMaterial({ roughness: v / 100 }); refreshSurface(); }, (v) => v + '%');
  const syncMetal = slider(surfOpts, 'Металл', 0, 100, 1,
    () => Math.round(api.getMaterial().metalness * 100),
    (v) => { api.setMaterial({ metalness: v / 100 }); refreshSurface(); }, (v) => v + '%');
  // Потолок 90%: материал, прозрачный полностью, ничем не отличается от
  // нетронутой поверхности — такой ползунок только сбивает с толку.
  const syncOpacity = slider(surfOpts, 'Прозрачность', 0, 90, 1,
    () => Math.round((1 - api.getMaterial().opacity) * 100),
    (v) => { api.setMaterial({ opacity: 1 - v / 100 }); refreshSurface(); }, (v) => v + '%');

  colMat.appendChild(el('div', 'modal-note',
    'Прозрачность — это стекло: сквозь закрашенное место видно модель насквозь. '
    + 'Насколько сильно ложится сама краска, задаёт «Нажим» кисти.'));

  /* Узор материала */
  colMat.appendChild(el('div', 'modal-sub', 'Узор'));
  const patGrid = el('div', 'pat-grid');
  colMat.appendChild(patGrid);

  // Своя картинка — такой же источник цвета, как процедурный узор, поэтому
  // стоит в том же списке, а не отдельной кнопкой в стороне.
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  colMat.appendChild(fileInput);

  const imgCard = el('button', 'pat-card');
  const imgCanvas = el('canvas');
  imgCanvas.width = 72; imgCanvas.height = 40;
  const imgLabel = el('span', 'n', 'Своя…');
  imgCard.append(imgCanvas, imgLabel);
  imgCard.addEventListener('click', () => {
    if (api.getMaterial().texture) api.setMaterial({ pattern: { id: 'image' } });
    else fileInput.click();
    refreshPattern();
  });
  imgCard.addEventListener('contextmenu', (e) => { e.preventDefault(); fileInput.click(); });
  imgCard.title = 'Загрузить свою текстуру · правая кнопка — выбрать другую';

  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const tex = await loadTextureFile(f);
      api.setMaterial({ texture: tex, pattern: { id: 'image' } });
      refreshPattern();
    } catch (err) {
      imgLabel.textContent = 'не прочлось';
      console.error(err);
    }
  });

  const patCards = PATTERNS.map((pt) => {
    const card = el('button', 'pat-card');
    const cv = el('canvas');
    cv.width = 72; cv.height = 40;
    card.append(cv, el('span', 'n', pt.name));
    card.addEventListener('click', () => {
      api.setMaterial({ pattern: { id: pt.id } });
      refreshPattern();
    });
    patGrid.appendChild(card);
    return { card, canvas: cv, pt };
  });

  const patOpts = el('div');
  colMat.appendChild(patOpts);
  const syncScale = slider(patOpts, 'Повтор', 1, 30, 1,
    () => Math.round(api.getMaterial().pattern.scale),
    (v) => { api.setMaterial({ pattern: { scale: v } }); refreshPattern(); }, (v) => String(v));
  const syncContrast = slider(patOpts, 'Контраст', 10, 250, 5,
    () => Math.round(api.getMaterial().pattern.contrast * 100),
    (v) => { api.setMaterial({ pattern: { contrast: v / 100 } }); refreshPattern(); }, (v) => v + '%');

  /* ── Колонка 3: библиотека ───────────────────────────────── */
  const colLib = el('div', 'mat-col lib');
  colLib.appendChild(el('div', 'modal-sub', 'Библиотека материалов'));
  const lib = el('div', 'mat-lib');
  colLib.appendChild(lib);

  const libBalls = [];
  MATERIAL_GROUPS.forEach((g, gi) => {
    const group = el('div', 'mat-group');
    group.dataset.open = gi === 0 ? '1' : '0';

    const head = el('button', 'mat-group-head');
    head.append(el('i', 'chev'), el('span', 'gn', g.name), el('span', 'cnt', String(g.colors.length)));
    head.addEventListener('click', () => {
      group.dataset.open = group.dataset.open === '1' ? '0' : '1';
    });

    const body = el('div', 'mat-group-body');
    for (const c of g.colors) {
      const btn = el('button', 'mat-ball');
      const cv = el('canvas');
      cv.width = cv.height = 108;   // рисуем крупнее, показываем мельче — края чище
      btn.appendChild(cv);
      btn.title = `${g.name} · ${c.toUpperCase()}`;
      const mat = materialFrom(g, c);
      btn.addEventListener('click', () => { api.setMaterial(mat); refresh(); });
      body.appendChild(btn);
      libBalls.push({ canvas: cv, mat, btn });
    }

    group.append(head, body);
    lib.appendChild(group);
  });
  let libDrawn = false;

  cols.append(colPick, colMat, colLib);

  /* ── Подвал ──────────────────────────────────────────────── */
  const hint = el('div', 'foot-hint', 'Выбранным материалом будет красить кисть');
  const cancelBtn = el('button', 'btn', 'Отмена');
  const okBtn = el('button', 'btn accent', 'ОК');
  cancelBtn.addEventListener('click', () => m.cancel());
  okBtn.addEventListener('click', () => m.close());
  m.foot.append(hint, cancelBtn, okBtn);

  m.onCancel = () => { if (snapshot) api.setMaterial({ ...snapshot }); };

  /* ── Отрисовка ───────────────────────────────────────────── */

  let hsv = [0, 0, 0];

  function paintSV() {
    const ctx = sv.getContext('2d');
    ctx.fillStyle = `rgb(${hsvToRgb(hsv[0], 1, 1).join(',')})`;
    ctx.fillRect(0, 0, sv.width, sv.height);

    const gw = ctx.createLinearGradient(0, 0, sv.width, 0);
    gw.addColorStop(0, '#fff'); gw.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gw; ctx.fillRect(0, 0, sv.width, sv.height);

    const gb = ctx.createLinearGradient(0, 0, 0, sv.height);
    gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, '#000');
    ctx.fillStyle = gb; ctx.fillRect(0, 0, sv.width, sv.height);

    ctx.beginPath();
    ctx.arc(hsv[1] * sv.width, (1 - hsv[2]) * sv.height, 6, 0, Math.PI * 2);
    ctx.strokeStyle = hsv[2] > 0.55 ? '#000' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function paintHue() {
    const ctx = hue.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, hue.height);
    for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `rgb(${hsvToRgb(i * 60, 1, 1).join(',')})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, hue.width, hue.height);
    const y = (hsv[0] / 360) * hue.height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, Math.max(0, y - 1.5), hue.width, 3);
  }

  function paintCurrent() {
    const mt = api.getMaterial();
    // Шахматка под шаром: иначе прозрачность материала ничем себя не выдаёт.
    // Гасим шар и плотностью краски, и прозрачностью самого материала.
    drawMaterialBall(bigBall, { ...mt, alpha: mt.opacity, checker: true });
    hex.value = rgbToHex(mt.color).toUpperCase();
    matName.textContent = mt.name;
  }

  function refreshPattern() {
    const mt = api.getMaterial();
    const a = mt.color, b = mt.color2 || mt.color;
    for (const { canvas, pt, card } of patCards) {
      drawPatternSample(canvas, { ...mt.pattern, id: pt.id }, a, b);
      card.classList.toggle('active', mt.pattern.id === pt.id);
    }

    const tex = mt.texture;
    imgCard.classList.toggle('active', mt.pattern.id === 'image');
    imgLabel.textContent = tex ? (tex.name.length > 9 ? tex.name.slice(0, 8) + '…' : tex.name) : 'Своя…';
    const ic = imgCanvas.getContext('2d');
    ic.clearRect(0, 0, imgCanvas.width, imgCanvas.height);
    if (tex) {
      ic.imageSmoothingEnabled = true;
      ic.drawImage(tex.canvas, 0, 0, imgCanvas.width, imgCanvas.height);
    } else {
      ic.fillStyle = '#24272c';
      ic.fillRect(0, 0, imgCanvas.width, imgCanvas.height);
      ic.fillStyle = '#8b929c';
      ic.font = '600 15px system-ui';
      ic.textAlign = 'center'; ic.textBaseline = 'middle';
      ic.fillText('+', imgCanvas.width / 2, imgCanvas.height / 2);
    }

    syncScale(); syncContrast();
    paintCurrent();
  }

  function paintShades() {
    shadeRow.innerHTML = '';
    for (const rgb of shadesOf(api.getMaterial().color)) {
      const sw = el('button', 'swatch');
      sw.style.background = `rgb(${rgb.join(',')})`;
      sw.title = rgbToHex(rgb).toUpperCase();
      sw.addEventListener('click', () => { api.setMaterial({ color: rgb, name: 'Оттенок' }); refresh(); });
      shadeRow.appendChild(sw);
    }
  }

  function refreshSurface() {
    const mt = api.getMaterial();
    surfBtns.forEach(({ btn, sp }) => btn.classList.toggle('on',
      Math.abs(sp.roughness - mt.roughness) < 0.02 && Math.abs(sp.metalness - mt.metalness) < 0.02));
    syncRough(); syncMetal(); syncOpacity();
    paintCurrent();   // шар обязан отзываться на ползунок, иначе его не видно
  }

  function setFromHsv() {
    api.setMaterial({ color: hsvToRgb(hsv[0], hsv[1], hsv[2]), name: 'Краска' });
    paintSV(); paintShades(); refreshPattern();
  }

  const dragOn = (canvas, handler) => {
    let on = false;
    const go = (e) => {
      const r = canvas.getBoundingClientRect();
      handler(
        Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      );
    };
    canvas.addEventListener('pointerdown', (e) => {
      on = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* не беда */ }
      go(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (on) go(e); });
    canvas.addEventListener('pointerup', () => { on = false; });
    canvas.addEventListener('pointercancel', () => { on = false; });
  };

  dragOn(sv, (x, y) => { hsv[1] = x; hsv[2] = 1 - y; setFromHsv(); });
  dragOn(hue, (_x, y) => { hsv[0] = y * 360; setFromHsv(); paintHue(); });

  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
      api.setMaterial({ color: hexToRgb(v.startsWith('#') ? v : '#' + v), name: 'Краска' });
      refresh();
    } else paintCurrent();
  });

  function refresh() {
    const mt = api.getMaterial();
    hsv = rgbToHsv(mt.color);
    paintHue(); paintSV(); paintShades();
    refreshSurface(); refreshPattern();

    // Шары библиотеки не меняются — рисуем их один раз, при первом показе.
    if (!libDrawn) {
      libBalls.forEach(({ canvas, mat }) => drawMaterialBall(canvas, mat));
      libDrawn = true;
    }
    const cur = rgbToHex(mt.color);
    libBalls.forEach(({ btn, mat }) => btn.classList.toggle('active', rgbToHex(mat.color) === cur));

    if (api.onChange) api.onChange();
  }

  m.onOpen = () => {
    snapshot = { ...api.getMaterial() };
    refresh();
  };

  return { open: () => m.open(), refresh, modal: m };
}

/**
 * Прочитать картинку в буфер для покраски.
 *
 * Держим и пиксели, и маленькое полотно: по пикселям кисть берёт цвет
 * тексель за текселем, полотно нужно превью. Большие снимки ужимаем —
 * для покраски low-poly хватает тысячи точек по стороне, а выборка из
 * четырёхмегапиксельной картинки заметно медленнее.
 */
export async function loadTextureFile(file) {
  const bitmap = await createImageBitmap(file);
  const MAX = 1024;
  const k = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  return { data: ctx.getImageData(0, 0, w, h).data, w, h, canvas, name: file.name };
}

/* ── Справка ───────────────────────────────────────────────────── */

/**
 * Что можно нажать. Держим таблицей: клавиш набралось столько, что
 * держать их в голове уже нельзя, а разбросанные по коду подписи
 * рассинхронизируются в первый же день.
 */
export const HELP = [
  { title: 'Мышь во вьюпорте', rows: [
    ['ЛКМ', 'работать выбранным инструментом'],
    ['ПКМ', 'вращать вид'],
    ['пробел + ЛКМ', 'двигать вид'],
    ['средняя кнопка', 'двигать вид'],
    ['колесо', 'приближать и отдалять'],
  ] },
  { title: 'Куб ориентации', rows: [
    ['протяжка', 'вращать вид, будто взялись за куб'],
    ['щелчок по грани', 'встать на осевой вид'],
    ['щелчок по ребру', 'вид под 45°'],
    ['щелчок по углу', 'изометрия'],
  ] },
  { title: 'Инструменты', rows: [
    ['B', 'кисть'],
    ['E', 'ластик'],
    ['I', 'пипетка — берёт материал целиком'],
    ['F', 'заливка связанных граней'],
    ['G', 'заливка UV-острова'],
    ['M', 'кисть по маске · Shift — вернуть'],
    ['R', 'прямоугольник · Shift — квадрат'],
    ['C', 'круг · Shift — правильный'],
    ['T', 'текст'],
    ['[  ]', 'размер кисти'],
  ] },
  { title: 'Вид', rows: [
    ['1 · 2', 'спереди · сзади'],
    ['3 · 4', 'слева · справа'],
    ['6 · 7', 'сверху · снизу'],
    ['0', 'три четверти'],
    ['5', 'перспектива ↔ ортография'],
    ['Home', 'вписать модель в кадр'],
  ] },
  { title: 'Панели', rows: [
    ['U', 'развёртка на полэкрана'],
    ['Tab', 'скрыть или показать панели'],
    ['Esc', 'закрыть окно без изменений'],
  ] },
  { title: 'Правка', rows: [
    ['⌘Z', 'отменить'],
    ['⇧⌘Z', 'вернуть'],
    ['щелчок по шагу истории', 'перейти к этому состоянию'],
  ] },
  { title: 'В развёртке', rows: [
    ['ЛКМ', 'тот же инструмент, что и на модели'],
    ['ПКМ или пробел', 'двигать полотно'],
    ['колесо', 'зум вокруг курсора'],
  ] },
  { title: 'Стоит знать', rows: [
    ['красная строка внизу', 'развёртка с наложением — мазок продублируется'],
    ['«Только видимое»', 'не красить грани, отвёрнутые от камеры'],
    ['«Нажим» кисти', 'насколько плотно ложится краска'],
    ['«Прозрачность» материала', 'стекло: модель видно насквозь'],
    ['Сохранить PNG', 'цвет и, если красили поверхностью, карту материала'],
  ] },
];

export function createHelpModal() {
  const m = new Modal('Справка', 'xwide');

  const grid = el('div', 'help-grid');
  for (const block of HELP) {
    const box = el('div', 'help-block');
    box.appendChild(el('div', 'modal-sub', block.title));
    const list = el('div', 'help-rows');
    for (const [key, what] of block.rows) {
      const row = el('div', 'help-row');
      row.append(el('kbd', null, key), el('span', null, what));
      list.appendChild(row);
    }
    box.appendChild(list);
    grid.appendChild(box);
  }
  m.body.appendChild(grid);

  const hint = el('div', 'foot-hint',
    'Полное описание — в README.md и СПРАВКА.md рядом с программой');
  const ok = el('button', 'btn accent', 'Понятно');
  ok.addEventListener('click', () => m.close());
  m.foot.append(hint, ok);

  return { open: () => m.open(), modal: m };
}

/* ── Окно «Сохранить как» ──────────────────────────────────────── */

/**
 * Выбор того, что уходит из инструмента наружу.
 *
 * Развилка одна и важная: отдать карты (их кладут на модель сами) или отдать
 * модель вместе с покраской — файл, который откроется в редакторе уже
 * покрашенным. Второе людям нужно чаще, поэтому стоит первым.
 *
 * @param {{save: (формат: string) => Promise<number>}} api
 */
export function createSaveAsModal(api) {
  const m = new Modal(t('save.title'));

  const ФОРМАТЫ = [
    { id: 'glb',  kind: 'model', key: 'save.glb' },
    { id: 'gltf', kind: 'model', key: 'save.gltf' },
    { id: 'obj',  kind: 'model', key: 'save.obj' },
    { id: 'png',  kind: 'maps',  key: 'save.png' },
  ];

  let выбран = 'glb';
  const кнопки = new Map();

  const подпись = el('div', 'modal-sub', t('save.format'));
  const список = el('div', 'save-list');

  for (const ф of ФОРМАТЫ) {
    const строка = el('button', 'save-row');
    строка.append(
      el('span', 'save-dot'),
      el('span', 'save-text', t(ф.key)),
    );
    строка.addEventListener('click', () => { выбран = ф.id; синхронизировать(); });
    список.appendChild(строка);
    кнопки.set(ф.id, { строка, ф });
  }

  const пояснение = el('div', 'foot-hint');

  function синхронизировать() {
    кнопки.forEach(({ строка, ф }, id) => {
      строка.classList.toggle('on', id === выбран);
      строка.querySelector('.save-text').textContent = t(ф.key);
    });
    const ф = ФОРМАТЫ.find((x) => x.id === выбран);
    пояснение.textContent = ф.kind === 'model' ? t('save.modelHint') : t('save.mapsHint');
    подпись.textContent = t('save.format');
    m.box.querySelector('.modal-head .t').textContent = t('save.title');
    отмена.textContent = t('save.cancel');
    готово.textContent = t('save.go');
  }

  m.body.append(подпись, список);

  const отмена = el('button', 'btn', t('save.cancel'));
  отмена.addEventListener('click', () => m.close());
  const готово = el('button', 'btn accent', t('save.go'));
  готово.addEventListener('click', async () => {
    готово.disabled = true;
    try { await api.save(выбран); } finally { готово.disabled = false; m.close(); }
  });
  m.foot.append(пояснение, отмена, готово);

  onLangChange(синхронизировать);
  синхронизировать();

  return { open: () => { синхронизировать(); m.open(); }, modal: m };
}

/* ── Окно настроек ─────────────────────────────────────────────── */

/**
 * Настройки программы. Нарочно короткие: сюда попадает то, что человек
 * ставит один раз и забывает. Всё, что крутят по ходу работы, остаётся на
 * панелях — иначе за настройками начнут ходить каждую минуту.
 *
 * @param {{getLang, setLang, getTexSize, setTexSize, getStartup, setStartup}} api
 */
export function createSettingsModal(api) {
  const m = new Modal(t('settings.title'));

  /** Ряд: подпись слева, управление справа, пояснение под ними. */
  function ряд(родитель, ключПодписи, ключПояснения, control) {
    const блок = el('div', 'set-block');
    const шапка = el('div', 'set-row');
    const подпись = el('label', 'set-label', t(ключПодписи));
    шапка.append(подпись, control);
    блок.appendChild(шапка);
    let пояснение = null;
    if (ключПояснения) {
      пояснение = el('div', 'set-hint', t(ключПояснения));
      блок.appendChild(пояснение);
    }
    родитель.appendChild(блок);
    return { подпись, пояснение, ключПодписи, ключПояснения };
  }

  const ряды = [];

  // Язык
  const выборЯзыка = el('select', 'set-select');
  for (const [код, имя] of Object.entries(LANGS)) {
    const o = el('option', null, имя);
    o.value = код;
    выборЯзыка.appendChild(o);
  }
  выборЯзыка.value = api.getLang();
  выборЯзыка.addEventListener('change', () => api.setLang(выборЯзыка.value));
  ряды.push(ряд(m.body, 'settings.language', 'settings.languageHint', выборЯзыка));

  // Размер текстуры
  const выборТекстуры = el('select', 'set-select');
  for (const размер of [512, 1024, 2048]) {
    const o = el('option', null, `${размер} × ${размер}`);
    o.value = размер;
    выборТекстуры.appendChild(o);
  }
  выборТекстуры.value = api.getTexSize();
  выборТекстуры.addEventListener('change', () => api.setTexSize(+выборТекстуры.value));
  ряды.push(ряд(m.body, 'settings.texture', 'settings.textureHint', выборТекстуры));

  // Начальный экран
  const галкаСтарта = el('input');
  галкаСтарта.type = 'checkbox';
  галкаСтарта.className = 'set-check';
  галкаСтарта.checked = api.getStartup();
  галкаСтарта.addEventListener('change', () => api.setStartup(галкаСтарта.checked));
  ряды.push(ряд(m.body, 'settings.startup', null, галкаСтарта));
  const подписьСтарта = el('div', 'set-hint', t('settings.startupShow'));
  m.body.appendChild(подписьСтарта);

  const готово = el('button', 'btn accent', t('settings.close'));
  готово.addEventListener('click', () => m.close());
  m.foot.append(готово);

  function синхронизировать() {
    m.box.querySelector('.modal-head .t').textContent = t('settings.title');
    for (const р of ряды) {
      р.подпись.textContent = t(р.ключПодписи);
      if (р.пояснение) р.пояснение.textContent = t(р.ключПояснения);
    }
    подписьСтарта.textContent = t('settings.startupShow');
    готово.textContent = t('settings.close');
    выборЯзыка.value = api.getLang();
    выборТекстуры.value = api.getTexSize();
    галкаСтарта.checked = api.getStartup();
  }

  onLangChange(синхронизировать);

  return { open: () => { синхронизировать(); m.open(); }, modal: m };
}

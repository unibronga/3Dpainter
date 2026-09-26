/**
 * Отрисовка панелей: палитра, слои, развёртка.
 * Ничего не знает о покраске — получает данные и обработчики.
 */

import { t } from './i18n.js';

/** Палитра под интерьеры и уровни: земля, зелень, вода, дерево, камень. */
export const PALETTE = [
  '#c8563c', '#e0a355', '#f2d6a2', '#8fae5a',
  '#4f7a4b', '#2f5d50', '#56809e', '#2f4858',
  '#9b7653', '#6b4f3a', '#d9d4c7', '#a8a49b',
  '#6e6a63', '#3c3a37', '#e8e4dc', '#1e1c1a',
];

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function renderSwatches(el, onPick) {
  el.innerHTML = '';
  for (const hex of PALETTE) {
    const d = document.createElement('div');
    d.className = 'swatch';
    d.style.background = hex;
    d.title = hex.toUpperCase();
    d.addEventListener('click', () => onPick(hex));
    el.appendChild(d);
  }
}

const EYE_ON = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M4 4l16 16"/><path d="M9.6 9.7A2.6 2.6 0 0 0 12 14.6"/><path d="M6.3 6.5C3.8 8.2 2 12 2 12s3.6 6 10 6c1.7 0 3.2-.4 4.5-1"/><path d="M19.5 15.4C21.2 13.9 22 12 22 12s-3.6-6-10-6c-.9 0-1.7.1-2.5.3"/></svg>';

/**
 * @param {HTMLElement} el
 * @param {PaintTarget} target — эталон структуры слоёв
 * @param {object} state {activeIndex}
 * @param {object} handlers {onSelect, onToggleVisible, onRename}
 */
export function renderLayers(el, target, state, handlers) {
  el.innerHTML = '';
  if (!target) return;

  target.layers.forEach((L, i) => {
    const row = document.createElement('div');
    row.className = 'layer' + (i === state.activeIndex ? ' active' : '');

    const eye = document.createElement('div');
    eye.className = 'eye' + (L.visible ? '' : ' off');
    eye.innerHTML = L.visible ? EYE_ON : EYE_OFF;
    eye.title = t(L.visible ? 'layers.hide' : 'layers.show');
    eye.addEventListener('click', (e) => { e.stopPropagation(); handlers.onToggleVisible(i); });

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = L.auto ? t('layers.name', L.auto) : L.name;
    name.title = t('layers.renameTip');
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const v = prompt(t('layers.renamePrompt'), L.name);
      if (v) handlers.onRename(i, v.trim());
    });

    row.append(eye, name);
    row.addEventListener('click', () => handlers.onSelect(i));
    el.appendChild(row);
  });
}

/**
 * Превью развёртки в боковой панели: текстура активного меша и сетка UV.
 * Маленькая карта под рукой нужна даже когда большой редактор закрыт —
 * по ней видно, куда легла краска и много ли пустого места на атласе.
 */
export function drawUVPreview(canvas, target, cache, showWire) {
  const box = canvas.parentElement;
  const w = Math.max(32, box.clientWidth);
  // Под масштабом интерфейса картинку растягивает zoom — рисуем плотнее,
  // иначе при 150–200% превью замылится.
  const ui = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const dpr = Math.min((devicePixelRatio || 1) * ui, 4);
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = canvas.height = Math.round(w * dpr);
    canvas.style.width = canvas.style.height = w + 'px';
  }

  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#15171a';
  ctx.fillRect(0, 0, S, S);
  if (!target) return;

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(target.canvas, 0, 0, S, S);

  // На плотной сетке линии в квадрате двести пикселей сливаются в серую
  // заливку — показывать нечего, а построение слоя стоит секунды.
  if (!showWire || !cache || cache.triCount > ПОРОГ_СЕТКИ) return;
  // Вычитанием, а не белым поверх: после растекания цвета островов атлас
  // у светлой модели белый, и белая линия по нему не видна вовсе.
  ctx.save();
  ctx.globalCompositeOperation = 'difference';
  ctx.drawImage(сеткаПревью(cache, S, dpr), 0, 0);
  ctx.restore();
}

/** Выше этого числа треугольников сетка в превью не рисуется. */
const ПОРОГ_СЕТКИ = 8000;

/**
 * Сетка развёртки для превью — рисуется один раз на модель и хранится.
 *
 * 🔴 Раньше она перечерчивалась при каждом обновлении превью, а превью
 * обновляется по ходу мазка. На сфере в 19 тысяч треугольников один путь с
 * `stroke()` занимал 0.7 секунды — именно отсюда брались рывки при покраске
 * крупной модели. Сама сетка при этом не меняется: меняется текстура под ней.
 */
const кэшСетки = new WeakMap();

function сеткаПревью(cache, S, dpr) {
  const прежняя = кэшСетки.get(cache);
  if (прежняя && прежняя.width === S) return прежняя;

  const слой = document.createElement('canvas');
  слой.width = слой.height = S;
  const g = слой.getContext('2d');

  const { uv, idx, triCount } = cache;
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = Math.max(1, dpr * 0.75);
  g.beginPath();
  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    g.moveTo(uv[i0 * 2] * S, (1 - uv[i0 * 2 + 1]) * S);
    g.lineTo(uv[i1 * 2] * S, (1 - uv[i1 * 2 + 1]) * S);
    g.lineTo(uv[i2 * 2] * S, (1 - uv[i2 * 2 + 1]) * S);
    g.closePath();
  }
  g.stroke();

  кэшСетки.set(cache, слой);
  return слой;
}

/** Подпись размера кисти в метрах или сантиметрах — масштаб проекта метровый. */
/** Размер файла: B, KB, MB — символы единиц, одинаковые на любом языке. */
export function formatBytes(байты) {
  if (байты > 1024 * 1024) return (байты / 1024 / 1024).toFixed(1) + ' MB';
  if (байты > 1024) return Math.round(байты / 1024) + ' KB';
  return байты + ' B';
}

export function formatSize(metres) {
  if (metres >= 1) return metres.toFixed(2).replace(/0$/, '') + ' ' + t('unit.m');
  return Math.round(metres * 100) + ' ' + t('unit.cm');
}

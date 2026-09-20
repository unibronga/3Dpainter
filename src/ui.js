/**
 * Отрисовка панелей: палитра, слои, развёртка.
 * Ничего не знает о покраске — получает данные и обработчики.
 */

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
 * @param {object} state {activeIndex, maskEditing}
 * @param {object} handlers {onSelect, onToggleVisible, onToggleMaskEdit}
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
    eye.title = L.visible ? 'Скрыть слой' : 'Показать слой';
    eye.addEventListener('click', (e) => { e.stopPropagation(); handlers.onToggleVisible(i); });

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = L.name;
    name.title = 'Двойной щелчок — переименовать';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const v = prompt('Имя слоя', L.name);
      if (v) handlers.onRename(i, v.trim());
    });

    const chip = document.createElement('div');
    chip.className = 'mask-chip' + (L.mask ? ' on' : '')
      + (i === state.activeIndex && state.maskEditing ? ' editing' : '');
    chip.textContent = 'М';
    chip.title = L.mask ? 'Маска есть — щелчок переключает правку маски' : 'Маски нет';
    chip.addEventListener('click', (e) => { e.stopPropagation(); handlers.onToggleMaskEdit(i); });

    row.append(eye, name, chip);
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
  const dpr = Math.min(devicePixelRatio || 1, 2);
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

  if (!showWire || !cache) return;
  const { uv, idx, triCount } = cache;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, dpr * 0.75);
  ctx.beginPath();
  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    ctx.moveTo(uv[i0 * 2] * S, (1 - uv[i0 * 2 + 1]) * S);
    ctx.lineTo(uv[i1 * 2] * S, (1 - uv[i1 * 2 + 1]) * S);
    ctx.lineTo(uv[i2 * 2] * S, (1 - uv[i2 * 2 + 1]) * S);
    ctx.closePath();
  }
  ctx.stroke();
}

/** Подпись размера кисти в метрах или сантиметрах — масштаб проекта метровый. */
export function formatSize(metres) {
  if (metres >= 1) return metres.toFixed(2).replace(/0$/, '') + ' м';
  return Math.round(metres * 100) + ' см';
}

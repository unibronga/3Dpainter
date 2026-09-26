/**
 * Выделение — область, в которой разрешено красить.
 *
 * Хранится маской по текселям (Uint8Array на сторону текстуры, 0..255), по
 * одной на каждый меш: у составной модели у каждого объекта своя развёртка.
 * Мазок, заливки и фигуры умножают своё покрытие на неё — поэтому выделение
 * работает одинаково для любого инструмента, ничего не зная о нём.
 *
 * Контур выделения рисуется лассо, но лассо на модели и лассо в развёртке
 * живут в разных плоскостях. В развёртке контур и есть плоскость текстуры —
 * он заливается прямо по текселям. На модели он лежит на экране, и каждый
 * тексель спрашивает, куда он проецируется, — так же, как печатаются фигуры.
 */

import { rasterTri } from './painter.js';

/** Режимы сложения нового контура с тем, что уже выделено. */
export const SEL_MODES = ['new', 'add', 'sub', 'and'];

/**
 * Залить многоугольник в маску W×H. Через 2D-холст: он даёт сглаженный край
 * и сам разбирается с самопересечениями (правило «ненулевой обмотки», как у
 * лассо в Photoshop).
 * @param {{x:number,y:number}[]} pts вершины в пикселях маски
 */
export function rasterPolygon(pts, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.fill('nonzero');

  const px = g.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3];
  return out;
}

/**
 * Перенести экранную маску на тексели меша.
 *
 * Для каждого текселя берём его точку на поверхности и смотрим, куда она
 * падает на экране. Отвёрнутые грани пропускаем, как и фигуры: иначе
 * выделение проступило бы на изнанке.
 *
 * @param {object} cache предрасчёт меша
 * @param {number} S сторона текстуры
 * @param {number[]} mvp элементы матрицы «модель → экран»
 * @param {Uint8Array} cover экранная маска W×H
 * @param {{x,y,z}} viewDir направление взгляда в осях меша
 * @returns {Uint8Array|null} маска текселей, либо null, если ничего не попало
 */
export function projectCover(cache, S, mvp, W, H, cover, viewDir, frontOnly) {
  const { faceNormal, triCount } = cache;
  const out = new Uint8Array(S * S);
  const e = mvp;
  const vx = viewDir.x, vy = viewDir.y, vz = viewDir.z;
  let any = false;

  for (let t = 0; t < triCount; t++) {
    if (frontOnly) {
      const d = faceNormal[t * 3] * vx + faceNormal[t * 3 + 1] * vy + faceNormal[t * 3 + 2] * vz;
      if (d >= 0) continue;
    }
    rasterTri(cache, S, t, (p, X, Y, Z) => {
      const w = e[3] * X + e[7] * Y + e[11] * Z + e[15];
      if (w <= 1e-6) return;
      const sx = ((((e[0] * X + e[4] * Y + e[8] * Z + e[12]) / w) * 0.5 + 0.5) * W) | 0;
      const sy = (((-((e[1] * X + e[5] * Y + e[9] * Z + e[13]) / w)) * 0.5 + 0.5) * H) | 0;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
      const a = cover[sy * W + sx];
      if (a > out[p]) { out[p] = a; any = true; }
    });
  }
  return any ? out : null;
}

/**
 * Сложить старое выделение с новым контуром. null в обоих аргументах и в
 * ответе значит «пусто».
 * @param {'new'|'add'|'sub'|'and'} mode
 */
export function combine(old, fresh, mode) {
  let out;
  switch (mode) {
    case 'add':
      if (!old) return fresh;
      if (!fresh) return old;
      out = old.slice();
      for (let i = 0; i < out.length; i++) if (fresh[i] > out[i]) out[i] = fresh[i];
      break;
    case 'sub':
      if (!old || !fresh) return old;
      out = old.slice();
      for (let i = 0; i < out.length; i++) out[i] = (out[i] * (255 - fresh[i])) / 255;
      break;
    case 'and':
      if (!old || !fresh) return null;
      out = old.slice();
      for (let i = 0; i < out.length; i++) if (fresh[i] < out[i]) out[i] = fresh[i];
      break;
    default:
      return fresh;
  }
  return isEmpty(out) ? null : out;
}

export function isEmpty(sel) {
  if (!sel) return true;
  for (let i = 0; i < sel.length; i++) if (sel[i]) return false;
  return true;
}

/**
 * Контур выделения отрезками по границам текселей — для «бегущих муравьёв»
 * в развёртке. Соседние отрезки одной линии склеиваются: иначе у большого
 * выделения их набирались бы десятки тысяч, и каждая перерисовка панели
 * обходила бы их все.
 *
 * @returns {Float32Array} x0,y0,x1,y1 подряд, в текселях
 */
export function outline(sel, S) {
  if (!sel) return new Float32Array(0);
  const segs = [];
  const on = (x, y) => x >= 0 && y >= 0 && x < S && y < S && sel[y * S + x] >= 128;

  // Горизонтальные границы: между строкой y-1 и y.
  for (let y = 0; y <= S; y++) {
    let start = -1;
    for (let x = 0; x <= S; x++) {
      const edge = x < S && on(x, y - 1) !== on(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { segs.push(start, y, x, y); start = -1; }
    }
  }
  // Вертикальные: между столбцом x-1 и x.
  for (let x = 0; x <= S; x++) {
    let start = -1;
    for (let y = 0; y <= S; y++) {
      const edge = y < S && on(x - 1, y) !== on(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { segs.push(x, start, x, y); start = -1; }
    }
  }
  return new Float32Array(segs);
}

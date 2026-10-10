/**
 * Лицо с выражениями — для любого персонажа.
 *
 * В игре лицо — отдельный материал, а выражения — листы-атласы: клетки
 * одного размера, игра показывает нужную. Глаза с бровями и рот — отдельно,
 * чтобы моргание и разговор менялись независимо.
 *
 * Здесь — всё, что не знает про интерфейс:
 *   - общий список выражений (встроенные — ключами, свои — как назвали);
 *   - маска и прямоугольник лица в развёртке;
 *   - вырезки выражений: лицо занимает малую долю атласа, и держать по
 *     полному слою на каждое выражение — сотни мегабайт при 2048. В стопке
 *     слоёв живёт по одному рабочему слою «Глаза» и «Рот» с показанным
 *     выражением, остальные лежат вырезками по прямоугольнику лица;
 *   - атласы и описание для выгрузки.
 *
 * 🔴 Ориентация. Холст покраски лежит строками сверху вниз «верхом к v = 1»,
 * а в glTF верх картинки — у v = 0: экспортёр переворачивает картинку сам.
 * Атласы пишем сразу в ориентации файла GLB, и прямоугольник лица в
 * описании — тоже в ней: тогда клетка атласа ложится на UV лица в GLB без
 * пересчёта.
 */

import { rasterTri } from './painter.js';

/** Встроенные выражения — общие имена, которые уходят в описание как есть. */
export const EXPRESSIONS = ['neutral', 'joy', 'laugh', 'sad', 'anger', 'fear',
  'surprise', 'embarrassed', 'pain', 'sleep', 'blink'];

// Части лица в порядке слоёв снизу вверх: «Всё лицо» — под глазами и ртом.
export const SLOTS = ['full', 'eyes', 'mouth'];

/**
 * Маска текселей лица и её прямоугольник (в ориентации холста покраски).
 * @param {Uint8Array} tris 1 — грань лица
 */
export function faceMaskOf(cache, S, tris) {
  const mask = new Uint8Array(S * S);
  let x0 = S, y0 = S, x1 = -1, y1 = -1;
  for (let t = 0; t < cache.triCount; t++) {
    if (!tris[t]) continue;
    rasterTri(cache, S, t, (p, X, Y, Z, x, y) => {
      mask[p] = 255;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    });
  }
  return { mask, rect: x1 < x0 ? null : { x0, y0, x1, y1 } };
}

/**
 * Грани, попавшие в выделение: больше половины их текселей выделено. Так
 * работает и лассо на модели, и лассо в развёртке — выделение одно и то же.
 */
export function trisFromSelection(cache, S, sel) {
  const tris = new Uint8Array(cache.triCount);
  let n = 0;
  for (let t = 0; t < cache.triCount; t++) {
    let all = 0, inside = 0;
    rasterTri(cache, S, t, (p) => { all += 1; if (sel[p] > 127) inside += 1; });
    if (all && inside * 2 > all) { tris[t] = 1; n += 1; }
  }
  return { tris, count: n };
}

const rectW = (r) => r.x1 - r.x0 + 1;
const rectH = (r) => r.y1 - r.y0 + 1;

/** Вырезка слоя по прямоугольнику лица: все четыре карты слоя. */
export function cropLayer(L, S, r) {
  const w = rectW(r), h = rectH(r);
  const c = {
    rgba: new Uint8ClampedArray(w * h * 4), rough: new Uint8Array(w * h),
    metal: new Uint8Array(w * h), opac: new Uint8Array(w * h),
  };
  for (let y = 0; y < h; y++) {
    const src = (r.y0 + y) * S + r.x0;
    c.rgba.set(L.rgba.subarray(src * 4, (src + w) * 4), y * w * 4);
    c.rough.set(L.rough.subarray(src, src + w), y * w);
    c.metal.set(L.metal.subarray(src, src + w), y * w);
    c.opac.set(L.opac.subarray(src, src + w), y * w);
  }
  return c;
}

/** Положить вырезку в слой; null — очистить прямоугольник (прозрачный фон). */
export function putCrop(L, S, r, c) {
  const w = rectW(r), h = rectH(r);
  for (let y = 0; y < h; y++) {
    const dst = (r.y0 + y) * S + r.x0;
    if (c) {
      L.rgba.set(c.rgba.subarray(y * w * 4, (y + 1) * w * 4), dst * 4);
      L.rough.set(c.rough.subarray(y * w, (y + 1) * w), dst);
      L.metal.set(c.metal.subarray(y * w, (y + 1) * w), dst);
      L.opac.set(c.opac.subarray(y * w, (y + 1) * w), dst);
    } else {
      L.rgba.fill(0, dst * 4, (dst + w) * 4);
      L.rough.fill(0, dst, dst + w);
      L.metal.fill(0, dst, dst + w);
      L.opac.fill(255, dst, dst + w);
    }
  }
}

/** Нарисовано ли в вырезке хоть что-то. */
export function cropIsEmpty(c) {
  for (let i = 3; i < c.rgba.length; i += 4) if (c.rgba[i] > 0) return false;
  return true;
}

/**
 * Атлас слота: клетки размером с прямоугольник лица, ⌈√n⌉ столбцов, лицо в
 * каждой клетке на одном месте. Порядок клеток — порядок `ids`.
 * Строки клетки переворачиваются — атлас в ориентации файла GLB.
 */
export function buildAtlas(crops, ids, r) {
  const w = rectW(r), h = rectH(r);
  const n = Math.max(1, ids.length);
  const columns = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * w;
  canvas.height = rows * h;
  const g = canvas.getContext('2d');
  ids.forEach((id, k) => {
    const c = crops.get(id);
    if (!c) return;
    const flipped = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) flipped.set(c.rgba.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
    g.putImageData(new ImageData(flipped, w, h), (k % columns) * w, Math.floor(k / columns) * h);
  });
  return { canvas, columns, rows };
}

/**
 * Описание лица для игры. Прямоугольник — в пикселях картинки GLB (верх у
 * v = 0) и в UV glTF; клетка атласа совпадает с ним по размеру.
 */
export function faceDescription({ name, size, rect, eyes, mouth, full }) {
  const w = rectW(rect), h = rectH(rect);
  const y = size - 1 - rect.y1;          // верх прямоугольника в ориентации файла
  const slot = (a) => a && {
    file: a.file, columns: a.columns, rows: a.rows,
    // Клетка k: столбец k % columns, строка floor(k / columns), сверху вниз.
    expressions: a.ids,
  };
  return {
    format: '3dpainter-face', version: 1, model: name, material: 'Face',
    texture: { width: size, height: size },
    faceRect: {
      x: rect.x0, y, width: w, height: h,
      u0: rect.x0 / size, v0: y / size, u1: (rect.x1 + 1) / size, v1: (y + h) / size,
    },
    cell: { width: w, height: h },
    eyes: slot(eyes),
    mouth: slot(mouth),
    // Всё лицо одной картинкой: игра показывает либо его, либо глаза + рот.
    full: slot(full),
  };
}

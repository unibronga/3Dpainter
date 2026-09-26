/**
 * Слои покраски и сборка итоговых карт.
 *
 * У каждого меша свой PaintTarget: развёртки разных объектов занимают один и
 * тот же квадрат 0..1, общая текстура на всех смешала бы их в кашу.
 *
 * Слой хранит не только цвет. Материал выбирается кистью и ложится вместе с
 * краской, поэтому шероховатость и металл живут по текселям, рядом с цветом:
 * иначе «покрасить железом» означало бы сделать железной всю модель.
 *
 * Хранение — сырые буферы Uint8, а не canvas: кисти нужен произвольный доступ
 * к пикселям, через 2D-контекст это было бы на порядок медленнее.
 */

import { t } from './i18n.js';

import * as THREE from 'three';

export const BLEND_MODES = ['normal', 'multiply', 'screen'];

export class Layer {
  /**
   * @param {number} size сторона текстуры
   * @param {string} name готовое имя, либо null — тогда имя даётся номером
   * @param {number} [auto] номер для автоимени: оно переводится вместе с
   *   интерфейсом, а переименованный вручную слой остаётся как назвали
   */
  constructor(size, name, auto) {
    this.name = name;
    this.auto = auto ?? null;
    this.rgba = new Uint8ClampedArray(size * size * 4); // прозрачный
    this.rough = new Uint8Array(size * size);           // 0..255 → 0..1
    this.metal = new Uint8Array(size * size);
    // Непрозрачность самого материала: стекло видно насквозь, краска — нет.
    this.opac = new Uint8Array(size * size).fill(255);
    this.mask = null;      // Uint8Array или null, пока маска не заведена
    this.visible = true;
    this.opacity = 1;
    this.blend = 'normal';
  }

  ensureMask(size) {
    if (!this.mask) this.mask = new Uint8Array(size * size).fill(255);
    return this.mask;
  }
}

export class PaintTarget {
  /**
   * @param {number} size — сторона текстуры в пикселях
   * @param {number[]} background — цвет подложки RGB 0..255, виден там, где не крашено
   */
  constructor(size, background = [176, 176, 176]) {
    this.size = size;
    this.background = background;
    // Некрашеная подложка — матовая, неметаллическая и непрозрачная.
    this.bgRough = 230;
    this.bgMetal = 0;
    this.hasTransparency = false;

    this.layers = [new Layer(size, null, 1)];
    this.activeIndex = 0;
    // Выделение лассо: маска текселей, где разрешено красить, либо null —
    // тогда красится всё. Живёт у цели, а не у слоя: смена слоя его не снимает.
    this.selection = null;

    this.composite = new Uint8ClampedArray(size * size * 4);
    this.imageData = new ImageData(this.composite, size, size);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;

    // Карта материала. three.js читает шероховатость из зелёного канала, а
    // металл из синего — стандартная упаковка, обе карты в одной текстуре.
    this.orm = new Uint8ClampedArray(size * size * 4);
    this.ormImageData = new ImageData(this.orm, size, size);
    this.ormCanvas = document.createElement('canvas');
    this.ormCanvas.width = this.ormCanvas.height = size;
    this.ormCtx = this.ormCanvas.getContext('2d');

    this.ormTexture = new THREE.CanvasTexture(this.ormCanvas);
    // Это данные, а не картинка: цветовое пространство трогать нельзя.
    this.ormTexture.colorSpace = THREE.NoColorSpace;

    this.compositeRect(null);
  }

  get activeLayer() { return this.layers[this.activeIndex]; }

  addLayer(name) {
    const l = new Layer(this.size, name || null, name ? null : this.layers.length + 1);
    this.layers.splice(this.activeIndex + 1, 0, l);
    this.activeIndex += 1;
    return l;
  }

  removeLayer(i) {
    if (this.layers.length <= 1) return false;
    this.layers.splice(i, 1);
    this.activeIndex = Math.min(this.activeIndex, this.layers.length - 1);
    this.compositeRect(null);
    return true;
  }

  /**
   * Пересобрать итоговые карты. rect = null — целиком, иначе только
   * прямоугольник мазка: перебирать миллион пикселей на каждое движение мыши
   * нельзя.
   * @param {{x0:number,y0:number,x1:number,y1:number}|null} rect
   */
  compositeRect(rect) {
    const S = this.size;
    const x0 = rect ? Math.max(0, rect.x0) : 0;
    const y0 = rect ? Math.max(0, rect.y0) : 0;
    const x1 = rect ? Math.min(S - 1, rect.x1) : S - 1;
    const y1 = rect ? Math.min(S - 1, rect.y1) : S - 1;
    if (x1 < x0 || y1 < y0) return;

    const out = this.composite;
    const orm = this.orm;
    const [bgR, bgG, bgB] = this.background;
    const layers = this.layers;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * S + x;
        const o = p * 4;

        let r = bgR, g = bgG, b = bgB;
        let rough = this.bgRough, metal = this.bgMetal;
        let opac = 255;

        for (let li = 0; li < layers.length; li++) {
          const L = layers[li];
          if (!L.visible || L.opacity <= 0) continue;

          let a = L.rgba[o + 3] / 255;
          if (a <= 0) continue;
          a *= L.opacity;
          if (L.mask) a *= L.mask[p] / 255;
          if (a <= 0) continue;

          const sr = L.rgba[o], sg = L.rgba[o + 1], sb = L.rgba[o + 2];
          let br, bg2, bb;
          switch (L.blend) {
            case 'multiply':
              br = (r * sr) / 255; bg2 = (g * sg) / 255; bb = (b * sb) / 255;
              break;
            case 'screen':
              br = 255 - ((255 - r) * (255 - sr)) / 255;
              bg2 = 255 - ((255 - g) * (255 - sg)) / 255;
              bb = 255 - ((255 - b) * (255 - sb)) / 255;
              break;
            default:
              br = sr; bg2 = sg; bb = sb;
          }
          r += (br - r) * a;
          g += (bg2 - g) * a;
          b += (bb - b) * a;

          // Поверхность режимами наложения не смешивается: «умножение»
          // осмысленно для цвета, но не для шероховатости.
          rough += (L.rough[p] - rough) * a;
          metal += (L.metal[p] - metal) * a;
          opac += (L.opac[p] - opac) * a;
        }

        // Альфа цветовой карты — это прозрачность материала: её читает
        // three.js, когда у меша включена прозрачность.
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = opac;
        orm[o] = 255; orm[o + 1] = rough; orm[o + 2] = metal; orm[o + 3] = 255;
      }
    }

    // Грязный прямоугольник putImageData — заливаем в canvas только изменённое.
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    this.ctx.putImageData(this.imageData, 0, 0, x0, y0, w, h);
    this.ormCtx.putImageData(this.ormImageData, 0, 0, x0, y0, w, h);
    this.texture.needsUpdate = true;
    this.ormTexture.needsUpdate = true;
  }

  /**
   * Пересчитать признак прозрачности. Полный проход по альфе: узнать, что
   * прозрачности больше НЕТ, иначе нельзя — накопительный флаг умел бы только
   * включаться.
   */
  updateTransparency() {
    const n = this.size * this.size;
    for (let p = 0; p < n; p++) {
      if (this.composite[p * 4 + 3] < 250) { this.hasTransparency = true; return true; }
    }
    this.hasTransparency = false;
    return false;
  }

  /** Цвет итоговой текстуры в точке UV — для пипетки. */
  sampleUV(u, v) {
    const o = this._offsetUV(u, v) * 4;
    return [this.composite[o], this.composite[o + 1], this.composite[o + 2]];
  }

  /** Материал целиком в точке UV: цвет плюс поверхность. */
  sampleMaterialUV(u, v) {
    const p = this._offsetUV(u, v);
    const o = p * 4;
    return {
      color: [this.composite[o], this.composite[o + 1], this.composite[o + 2]],
      roughness: this.orm[o + 1] / 255,
      metalness: this.orm[o + 2] / 255,
      opacity: this.composite[o + 3] / 255,
    };
  }

  _offsetUV(u, v) {
    const S = this.size;
    const x = Math.min(S - 1, Math.max(0, Math.floor(u * S)));
    const y = Math.min(S - 1, Math.max(0, Math.floor((1 - v) * S)));
    return y * S + x;
  }

  dispose() {
    this.texture.dispose();
    this.ormTexture.dispose();
  }
}

/**
 * Журнал правок — линейный список с указателем на текущее состояние, как
 * палитра «История» в Photoshop: можно не только шагнуть назад, но и прыгнуть
 * к любому шагу.
 *
 * Хранится только прямоугольник правки, а не весь слой: полный снимок
 * текстуры 2048² — это 16 МБ на каждый мазок.
 */
export class History {
  constructor(limit = 40) {
    this.limit = limit;
    this.entries = [];
    this.index = -1;          // -1 = исходное состояние, до первой правки
    this.onChange = null;
  }

  push(entry) {
    // Новая правка после отмены обрубает всё, что было впереди.
    this.entries.length = this.index + 1;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    this._changed();
  }

  undo() {
    if (!this.canUndo) return false;
    restore(this.entries[this.index], 'before');
    this.index -= 1;
    this._changed();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this.index += 1;
    restore(this.entries[this.index], 'after');
    this._changed();
    return true;
  }

  /** Перейти к состоянию после шага i (-1 — исходное). */
  goto(i) {
    const target = Math.max(-1, Math.min(this.entries.length - 1, i));
    while (this.index > target) { restore(this.entries[this.index], 'before'); this.index -= 1; }
    while (this.index < target) { this.index += 1; restore(this.entries[this.index], 'after'); }
    this._changed();
  }

  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.entries.length - 1; }

  clear() { this.entries.length = 0; this.index = -1; this._changed(); }

  /**
   * Выбросить записи, которые больше не к чему применять — например, правки
   * удалённого слоя. Указатель съезжает вместе с ними, чтобы история не
   * обещала шагов, которых уже нет.
   */
  prune(keep) {
    const kept = [];
    let index = -1;
    this.entries.forEach((e, i) => {
      if (!keep(e)) return;
      kept.push(e);
      if (i <= this.index) index = kept.length - 1;
    });
    this.entries = kept;
    this.index = index;
    this._changed();
  }

  _changed() { if (this.onChange) this.onChange(this); }
}

/**
 * Вернуть прямоугольник в состояние «до» или «после» правки.
 * Правка трогает несколько буферов сразу (цвет, шероховатость, металл),
 * поэтому запись хранит их списком.
 */
function restore(entry, which) {
  const { target, rect } = entry;
  const S = target.size;
  const w = rect.x1 - rect.x0 + 1;

  for (const part of entry.parts) {
    const data = part[which];
    for (let y = rect.y0, row = 0; y <= rect.y1; y++, row++) {
      const off = (y * S + rect.x0) * part.stride;
      part.buf.set(data.subarray(row * w * part.stride, (row + 1) * w * part.stride), off);
    }
  }
  target.compositeRect(rect);
}

/**
 * Вырезать прямоугольник из буфера канала — для записи в журнал отмены.
 * @param {Uint8ClampedArray|Uint8Array} src
 * @param {number} size — сторона текстуры
 * @param {number} stride — 4 для цвета, 1 для одноканальных
 */
/**
 * Растечь покраску слоя в незанятые тексели.
 *
 * Острова развёртки занимают около половины атласа, остальное — пустота.
 * Она мешает дважды. На экране: мазок у края острова заходит на неё, и
 * вокруг кисти появляется серый прямоугольник промежутка. На модели хуже:
 * видеокарта берёт тексели с запасом (фильтрация, мип-уровни), подмешивает
 * пустоту — и вдоль каждого шва ползёт серая кайма.
 *
 * Лечится тем же, чем лечат любой атлас: пустые тексели получают цвет
 * ближайшего закрашенного. Идём волной от краёв покраски наружу — так
 * каждый тексель достаётся ближайшему соседу, а весь атлас проходится за
 * один раз, а не за сотню расширений подряд.
 *
 * Вместе с цветом переносятся и карты поверхности: иначе в промежутках
 * осталась бы чужая шероховатость.
 *
 * @param {Layer} layer
 * @param {number} size сторона текстуры
 * @returns {number} сколько текселей заполнено
 */
export function bleedLayer(layer, size) {
  const N = size * size;
  const { rgba, rough, metal, opac } = layer;

  // Очередь: сперва всё закрашенное, дальше волна растекается от него.
  const очередь = new Int32Array(N);
  const откуда = new Int32Array(N).fill(-1);
  let хвост = 0;
  for (let p = 0; p < N; p++) if (rgba[p * 4 + 3] > 0) очередь[хвост++] = p;

  if (!хвост || хвост === N) return 0;   // красить нечем или нечего

  let голова = 0, заполнено = 0;
  while (голова < хвост) {
    const p = очередь[голова++];
    const x = p % size, y = (p / size) | 0;

    for (let e = 0; e < 4; e++) {
      const nx = x + (e === 0 ? -1 : e === 1 ? 1 : 0);
      const ny = y + (e === 2 ? -1 : e === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;

      const n = ny * size + nx;
      if (rgba[n * 4 + 3] > 0 || откуда[n] >= 0) continue;   // занято или уже в очереди

      // 🔴 Запоминаем не соседа, а сам остров: сосед по волне ещё пуст, и
      // цепочка «сосед соседа» протащила бы прозрачность через весь атлас.
      откуда[n] = rgba[p * 4 + 3] > 0 ? p : откуда[p];
      очередь[хвост++] = n;
    }
  }

  // Переносим значения по готовым ссылкам: во время обхода этого делать
  // нельзя — свежезаполненный тексель стал бы источником для следующего,
  // и цвет уползал бы от острова полосами.
  for (let i = 0; i < хвост; i++) {
    const p = очередь[i];
    const src = откуда[p];
    if (src < 0) continue;
    const a = p * 4, b = src * 4;
    rgba[a] = rgba[b]; rgba[a + 1] = rgba[b + 1]; rgba[a + 2] = rgba[b + 2];
    rgba[a + 3] = rgba[b + 3];
    rough[p] = rough[src]; metal[p] = metal[src]; opac[p] = opac[src];
    заполнено += 1;
  }
  return заполнено;
}

export function cutRect(src, size, stride, rect) {
  const w = rect.x1 - rect.x0 + 1;
  const h = rect.y1 - rect.y0 + 1;
  const out = stride === 4 ? new Uint8ClampedArray(w * h * 4) : new Uint8Array(w * h);

  for (let y = rect.y0, row = 0; y <= rect.y1; y++, row++) {
    const off = (y * size + rect.x0) * stride;
    out.set(src.subarray(off, off + w * stride), row * w * stride);
  }
  return out;
}

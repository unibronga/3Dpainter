/**
 * Ядро покраски — проекция кисти на поверхность.
 *
 * Наивный способ (взять UV под курсором и поставить круг на текстуре) ломается
 * на низкополигональной модели: где развёртка растянута, кисть растягивается
 * вместе с ней, а на шве мазок обрывается.
 *
 * Здесь наоборот: мазок — это шар в пространстве модели. Для каждого
 * треугольника, попавшего в шар, считаем его тексели, для каждого текселя
 * восстанавливаем точку на поверхности и меряем расстояние до центра кисти.
 * Размер мазка тогда одинаков по всей модели, а шов проходится сам — по обе
 * стороны шва лежат треугольники, и оба попадают в шар.
 */


import { cutRect } from './layers.js';
import { queryGrid } from './mesh-cache.js';
import { patternAt, hasPattern } from './patterns.js';

const PAD = 2; // растекание за край треугольника, тексели — закрывает щели на швах

/* ── Прямоугольник правки ──────────────────────────────────────── */

export function emptyRect() {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}
function expand(r, x, y) {
  if (x < r.x0) r.x0 = x;
  if (y < r.y0) r.y0 = y;
  if (x > r.x1) r.x1 = x;
  if (y > r.y1) r.y1 = y;
}
function merge(a, b) {
  if (b.x1 < b.x0) return a;
  if (a.x1 < a.x0) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
export function isEmptyRect(r) { return r.x1 < r.x0 || r.y1 < r.y0; }

/* ── Растеризация треугольника в тексели ───────────────────────── */

/**
 * Пройти тексели, накрытые треугольником t (плюс полоса PAD за краем).
 * В обратный вызов приходит номер текселя и точка на поверхности,
 * которой этот тексель соответствует.
 *
 * @param {function(number, number, number, number, number, number):void} cb
 *        (p, X, Y, Z, x, y)
 */
function rasterTri(cache, S, t, cb) {
  const { pos, uv, idx } = cache;
  const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];

  const u0 = uv[i0 * 2] * S, v0 = (1 - uv[i0 * 2 + 1]) * S;
  const u1 = uv[i1 * 2] * S, v1 = (1 - uv[i1 * 2 + 1]) * S;
  const u2 = uv[i2 * 2] * S, v2 = (1 - uv[i2 * 2 + 1]) * S;

  const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
  if (Math.abs(den) < 1e-9) return; // треугольник схлопнут в развёртке
  const inv = 1 / den;

  let minX = Math.floor(Math.min(u0, u1, u2)) - PAD;
  let maxX = Math.ceil(Math.max(u0, u1, u2)) + PAD;
  let minY = Math.floor(Math.min(v0, v1, v2)) - PAD;
  let maxY = Math.ceil(Math.max(v0, v1, v2)) + PAD;
  if (minX < 0) minX = 0; if (minY < 0) minY = 0;
  if (maxX > S - 1) maxX = S - 1; if (maxY > S - 1) maxY = S - 1;
  if (maxX < minX || maxY < minY) return;

  const a0x = pos[i0 * 3], a0y = pos[i0 * 3 + 1], a0z = pos[i0 * 3 + 2];
  const a1x = pos[i1 * 3], a1y = pos[i1 * 3 + 1], a1z = pos[i1 * 3 + 2];
  const a2x = pos[i2 * 3], a2y = pos[i2 * 3 + 1], a2z = pos[i2 * 3 + 2];

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const rowOff = y * S;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;

      let l0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * inv;
      let l1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * inv;
      let l2 = 1 - l0 - l1;

      if (l0 < 0 || l1 < 0 || l2 < 0) {
        // Тексель за краем треугольника. Оставляем его, только если он в
        // полосе PAD, — это и есть растекание через шов.
        //
        // 🔴 Прижатая к треугольнику точка годится, чтобы измерить расстояние
        // до края, но не годится как точка поверхности: она ближе к центру
        // кисти, чем настоящая, и альфа выходит завышенной. На шве это
        // незаметно, а на внутреннем ребре соседний треугольник красит те же
        // тексели честно — и вдоль каждого ребра остаётся гребень лишней
        // краски в три текселя (замер: 67 → 122 из 255). Поэтому положение
        // берём по НЕприжатым координатам: это та же плоскость треугольника,
        // продолженная за край, и поперёк ребра она сходится с соседом.
        let b0 = l0 < 0 ? 0 : l0, b1 = l1 < 0 ? 0 : l1, b2 = l2 < 0 ? 0 : l2;
        const s = b0 + b1 + b2;
        if (s <= 0) continue;
        b0 /= s; b1 /= s; b2 /= s;
        const cu = b0 * u0 + b1 * u1 + b2 * u2;
        const cv = b0 * v0 + b1 * v1 + b2 * v2;
        if ((px - cu) ** 2 + (py - cv) ** 2 > PAD * PAD) continue;
      }

      cb(rowOff + x,
         l0 * a0x + l1 * a1x + l2 * a2x,
         l0 * a0y + l1 * a1y + l2 * a2y,
         l0 * a0z + l1 * a1z + l2 * a2z,
         x, y);
    }
  }
}

/** Спад кисти от центра к краю: до жёсткости — плато, дальше плавно в ноль. */
function falloff(x, hardness) {
  if (x >= 1) return 0;
  if (x <= hardness) return 1;
  if (hardness >= 0.999) return 1;
  const t = (x - hardness) / (1 - hardness);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Зерно кисти — постоянный шум, привязанный к текселю, а не к отпечатку.
 * Если считать случайное число на каждый отпечаток, след будет мерцать:
 * один и тот же тексель за мазок задевается десятки раз.
 */
function grainAt(p) {
  let h = (p * 374761393 + 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Настройки кисти по умолчанию — ими пользуются и вьюпорт, и развёртка. */
export const DEFAULT_BRUSH = {
  hardness: 0.7,
  flow: 1,
  grain: 0,
  shape: 'round',   // 'round' | 'square'
};

/* ── Мазок ─────────────────────────────────────────────────────── */

export class Stroke {
  /**
   * @param {PaintTarget} target
   * @param {object} cache — предрасчёт меша
   * @param {object} opts
   *   channel: 'rgba' | 'mask'
   *   mode:    'paint' | 'erase' | 'mask-add' | 'mask-sub'
   *   color:   [r,g,b] 0..255
   *   opacity: 0..1 — укрывистость мазка, предел непрозрачности за один мазок
   *   alpha:   0..1 — прозрачность материала (стекло), уходит в карту;
   *                   к укрывистости отношения не имеет
   */
  constructor(target, cache, opts) {
    this.target = target;
    this.cache = cache;
    this.channel = opts.channel || 'rgba';
    this.mode = opts.mode || 'paint';
    this.color = opts.color || [0, 0, 0];
    this.opacity = opts.opacity ?? 1;

    this.layer = target.activeLayer;
    if (this.channel === 'mask') this.layer.ensureMask(target.size);

    // Поверхность материала ложится вместе с краской, по тем же текселям.
    this.matRough = Math.round((opts.roughness ?? 0.9) * 255);
    this.matMetal = Math.round((opts.metalness ?? 0) * 255);
    this.matOpac = Math.round((opts.alpha ?? 1) * 255);
    // Своя картинка и процедурный узор — два источника цвета, но не разом:
    // картинка уже несёт свой рисунок, накладывать на неё узор бессмысленно.
    this.texture = (opts.pattern?.id === 'image' && opts.texture) ? opts.texture : null;
    this.pattern = (!this.texture && hasPattern(opts.pattern) && opts.pattern.id !== 'image')
      ? opts.pattern : null;
    this.tiles = Math.max(0.05, (opts.pattern?.scale ?? 8) / 4);
    this.color2 = opts.color2 || opts.color || [0, 0, 0];

    const S = target.size;
    // Накопитель мазка: внутри ОДНОГО ПРОХОДА альфа берётся по максимуму,
    // иначе при медленном движении кисть темнеет там, где отпечатки легли
    // друг на друга. См. _pathAt(): возврат мазка на собственный след —
    // это уже второй проход, и он ложится поверх первого.
    this.acc = new Uint8Array(S * S);
    this.laid = new Uint8Array(S * S);   // что положено проходами до текущего
    this.seen = new Uint16Array(S * S);  // путь кисти на миг последнего касания
    this.path = 0;      // пройденный путь, в квантах
    this.quant = 0;     // длина кванта: восьмая радиуса кисти
    this.away = 16;     // с какого пути касание считается новым проходом
    this.hasPrev = false;
    this.prevX = 0; this.prevY = 0; this.prevZ = 0;
    this.base = (this.channel === 'rgba' ? this.layer.rgba : this.layer.mask).slice();
    if (this.channel === 'rgba' && this.mode === 'paint') {
      this.baseRough = this.layer.rough.slice();
      this.baseMetal = this.layer.metal.slice();
      this.baseOpac = this.layer.opac.slice();
    }
    this.dirty = emptyRect();    // всё, что мазок тронул — для журнала отмены
    this.pending = emptyRect();  // ещё не выложенное в слой
  }

  /**
   * Путь кисти к этому отпечатку — им отличается продолжение прохода от
   * возврата на собственный след.
   *
   * По числу отпечатков их не различить: отпечаток ставится не реже одного
   * на событие указателя, и при медленном ведении их десятки на одном месте.
   * Поэтому считается ПУТЬ: если с последнего касания кисть прошла больше
   * своего поперечника, значит она успела уйти и вернуться — это второй
   * проход, и краска ложится поверх, как у отдельного мазка. Без этого на
   * перекрестье остаётся бледная звёздочка (замер: в клине 168 против 209
   * из 255 у двух мазков).
   *
   * Квант — восьмая радиуса; Uint16 на тексель хватает на восемь тысяч
   * радиусов пути, длиннее одного мазка не бывает.
   *
   * @param {number} radius — радиус отпечатка в тех же единицах, что и центр
   * @returns {number} отметка пути, 0 означало бы «не касались»
   */
  _pathAt(radius, x, y, z) {
    if (!this.quant) {
      this.quant = radius / 8;
      this.away = Math.max(2, Math.round(2 * radius / this.quant));
    }
    if (this.hasPrev) {
      const dx = x - this.prevX, dy = y - this.prevY, dz = z - this.prevZ;
      this.path += Math.sqrt(dx * dx + dy * dy + dz * dz) / this.quant;
    }
    this.prevX = x; this.prevY = y; this.prevZ = z; this.hasPrev = true;
    return 1 + Math.min(65000, this.path | 0);
  }

  /**
   * Отпечаток кисти. Все координаты — локальные для меша.
   * @param {{x:number,y:number,z:number}} c — центр
   * @param {number} radius
   * @param {{x:number,y:number,z:number}} viewDir — куда смотрит камера
   */
  /**
   * Отпечаток кисти по поверхности.
   * @param {object} brush {hardness, flow, grain, shape}
   * @param {object} [basis] {right, up} — локальные оси экрана, нужны квадратной
   *        форме: у круга направления нет, у квадрата есть.
   */
  dab(c, radius, viewDir, brush = DEFAULT_BRUSH, frontOnly = true, basis = null) {
    const { centroid, triRadius, faceNormal, grid } = this.cache;
    const S = this.target.size;
    const acc = this.acc, laid = this.laid, seen = this.seen;
    const now = this._pathAt(radius, c.x, c.y, c.z), away = this.away;
    const rInv = 1 / radius;
    const rect = emptyRect();

    const hardness = brush.hardness ?? 0.7;
    const flow = brush.flow ?? 1;
    const grain = brush.grain ?? 0;
    const square = brush.shape === 'square' && basis;

    const cx = c.x, cy = c.y, cz = c.z;
    const vx = viewDir.x, vy = viewDir.y, vz = viewDir.z;
    // Угол квадрата дальше от центра, чем его сторона, — ищем шире.
    const reachR = square ? radius * 1.45 : radius;

    // Кандидаты берём из сетки: перебирать все треугольники модели на каждый
    // отпечаток — главный источник тормозов на большой сцене.
    queryGrid(grid, cx, cy, cz, reachR, (t) => {
      // Отбраковка по оболочке треугольника — дешевле, чем растеризовать.
      const gx = centroid[t * 3] - cx;
      const gy = centroid[t * 3 + 1] - cy;
      const gz = centroid[t * 3 + 2] - cz;
      const reach = reachR + triRadius[t];
      if (gx * gx + gy * gy + gz * gz > reach * reach) return;

      // Отвёрнутые от камеры грани не красим — иначе кисть пробивает модель
      // насквозь и пачкает изнанку.
      if (frontOnly) {
        const d = faceNormal[t * 3] * vx + faceNormal[t * 3 + 1] * vy + faceNormal[t * 3 + 2] * vz;
        if (d >= 0) return;
      }

      rasterTri(this.cache, S, t, (p, X, Y, Z, px, py) => {
        const ox = X - cx, oy = Y - cy, oz = Z - cz;
        const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (d > reachR) return;

        let k;
        if (square) {
          // Квадрат меряем не по расстоянию, а по большей из двух проекций
          // на экранные оси — иначе получился бы тот же круг.
          const a1 = Math.abs(ox * basis.right.x + oy * basis.right.y + oz * basis.right.z);
          const a2 = Math.abs(ox * basis.up.x + oy * basis.up.y + oz * basis.up.z);
          k = Math.max(a1, a2) * rInv;
        } else {
          k = d * rInv;
        }
        if (k > 1) return;

        let a = falloff(k, hardness) * flow;
        if (grain > 0) a *= 1 - grain * grainAt(p);
        a *= 255;
        const was = seen[p];
        if (was && now - was > away) laid[p] = acc[p]; // кисть уходила — новый проход
        seen[p] = now;
        const l = laid[p];
        const v = l + a * (1 - l / 255);
        if (v <= acc[p]) return;
        acc[p] = v;
        expand(rect, px, py);
      });
    });

    if (isEmptyRect(rect)) return false;
    this.pending = merge(this.pending, rect);
    return true;
  }

  /**
   * Отпечаток прямо по развёртке — для работы в UV-редакторе.
   * Здесь кисть снова обычный круг: мы рисуем по текстуре, а не по поверхности.
   * @param {number} px @param {number} py — центр в текселях
   */
  dab2D(px, py, radius, brush = DEFAULT_BRUSH) {
    const S = this.target.size;
    const acc = this.acc, laid = this.laid, seen = this.seen;
    const now = this._pathAt(radius, px, py, 0), away = this.away;
    const rInv = 1 / radius;
    const hardness = brush.hardness ?? 0.7;
    const flow = brush.flow ?? 1;
    const grain = brush.grain ?? 0;
    const square = brush.shape === 'square';

    const x0 = Math.max(0, Math.floor(px - radius));
    const x1 = Math.min(S - 1, Math.ceil(px + radius));
    const y0 = Math.max(0, Math.floor(py - radius));
    const y1 = Math.min(S - 1, Math.ceil(py + radius));
    if (x1 < x0 || y1 < y0) return false;

    const rect = emptyRect();
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - py;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        const k = square
          ? Math.max(Math.abs(dx), Math.abs(dy)) * rInv
          : Math.sqrt(dx * dx + dy * dy) * rInv;
        if (k > 1) continue;
        const p = y * S + x;
        let a = falloff(k, hardness) * flow;
        if (grain > 0) a *= 1 - grain * grainAt(p);
        a *= 255;
        const was = seen[p];
        if (was && now - was > away) laid[p] = acc[p]; // кисть уходила — новый проход
        seen[p] = now;
        const l = laid[p];
        const v = l + a * (1 - l / 255);
        if (v <= acc[p]) continue;
        acc[p] = v;
        expand(rect, x, y);
      }
    }

    if (isEmptyRect(rect)) return false;
    this.pending = merge(this.pending, rect);
    return true;
  }

  /**
   * Отпечаток по экранному трафарету — им печатаются фигуры и текст.
   *
   * Для каждого текселя берём его точку на поверхности, проецируем на экран
   * и спрашиваем трафарет, попал ли он в фигуру. Так прямоугольник остаётся
   * прямоугольником на экране, как бы ни была изогнута поверхность под ним.
   *
   * @param {number[]} mvp — элементы матрицы «модель → экран»
   * @param {function(number, number): number} stencil — покрытие 0..1
   */
  stampProjected(mvp, viewW, viewH, stencil, viewDir, brush = DEFAULT_BRUSH, frontOnly = true) {
    const { faceNormal, triCount } = this.cache;
    const S = this.target.size;
    const acc = this.acc;
    const rect = emptyRect();
    const flow = brush.flow ?? 1;
    const e = mvp;
    const vx = viewDir.x, vy = viewDir.y, vz = viewDir.z;

    for (let t = 0; t < triCount; t++) {
      // Отвёрнутые грани не печатаем: иначе фигура проступит на изнанке.
      if (frontOnly) {
        const d = faceNormal[t * 3] * vx + faceNormal[t * 3 + 1] * vy + faceNormal[t * 3 + 2] * vz;
        if (d >= 0) continue;
      }

      rasterTri(this.cache, S, t, (p, X, Y, Z, px, py) => {
        const w = e[3] * X + e[7] * Y + e[11] * Z + e[15];
        if (w <= 1e-6) return;                      // точка за камерой
        const sx = (((e[0] * X + e[4] * Y + e[8] * Z + e[12]) / w) * 0.5 + 0.5) * viewW;
        const sy = ((-((e[1] * X + e[5] * Y + e[9] * Z + e[13]) / w)) * 0.5 + 0.5) * viewH;

        const a = stencil(sx, sy) * flow * 255;
        if (a <= acc[p]) return;
        acc[p] = a;
        expand(rect, px, py);
      });
    }

    if (isEmptyRect(rect)) return false;
    this.pending = merge(this.pending, rect);
    return true;
  }

  /** Тот же трафарет, но прямо по текселям — для работы в развёртке. */
  stampStencil2D(stencil, box, brush = DEFAULT_BRUSH) {
    const S = this.target.size;
    const acc = this.acc;
    const rect = emptyRect();
    const flow = brush.flow ?? 1;

    const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(S - 1, Math.ceil(box.x1));
    const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(S - 1, Math.ceil(box.y1));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const a = stencil(x + 0.5, y + 0.5) * flow * 255;
        const p = y * S + x;
        if (a <= acc[p]) continue;
        acc[p] = a;
        expand(rect, x, y);
      }
    }

    if (isEmptyRect(rect)) return false;
    this.pending = merge(this.pending, rect);
    return true;
  }

  /** Залить набор треугольников целиком — для заливок по граням и острову. */
  fillTriangles(triSet) {
    const S = this.target.size;
    const acc = this.acc;
    const rect = emptyRect();

    for (const t of triSet) {
      rasterTri(this.cache, S, t, (p, X, Y, Z, px, py) => {
        if (acc[p] === 255) return;
        acc[p] = 255;
        expand(rect, px, py);
      });
    }

    if (isEmptyRect(rect)) return false;
    this.pending = merge(this.pending, rect);
    return true;
  }

  /** Залить всю текстуру слоя. */
  fillAll() {
    const S = this.target.size;
    this.acc.fill(255);
    this.pending = merge(this.pending, { x0: 0, y0: 0, x1: S - 1, y1: S - 1 });
    return true;
  }

  /**
   * Выложить накопленное в слой и пересобрать текстуру.
   *
   * Вызывается раз в кадр, а не на каждый отпечаток: за один взмах мыши их
   * ставятся десятки, а каждая сборка тянет за собой перезаливку текстуры на
   * видеокарту — именно на этом инструмент и тормозил.
   */
  flush() {
    if (isEmptyRect(this.pending)) return false;
    this.apply(this.pending);
    this.dirty = merge(this.dirty, this.pending);
    // Что именно поменялось в этот раз — по нему панели перерисовывают
    // только изменившийся кусок, а не всё полотно.
    this.lastApplied = { ...this.pending };
    this.pending = emptyRect();
    return true;
  }

  /** Перенести накопитель мазка в слой — считаем от состояния до мазка. */
  apply(rect) {
    const S = this.target.size;
    const acc = this.acc, base = this.base, op = this.opacity;

    if (this.channel === 'mask') {
      const dst = this.layer.mask;
      const sub = this.mode === 'mask-sub';
      for (let y = rect.y0; y <= rect.y1; y++) {
        for (let x = rect.x0; x <= rect.x1; x++) {
          const p = y * S + x;
          const a = (acc[p] / 255) * op;
          if (a <= 0) continue;
          const b = base[p];
          dst[p] = sub ? b * (1 - a) : b + (255 - b) * a;
        }
      }
    } else {
      const dst = this.layer.rgba;
      const [cr, cg, cb] = this.color;
      const erase = this.mode === 'erase';
      const dstR = this.layer.rough, dstM = this.layer.metal, dstO = this.layer.opac;
      const baseR = this.baseRough, baseM = this.baseMetal, baseO = this.baseOpac;
      const matR = this.matRough, matM = this.matMetal, matO = this.matOpac;
      const pat = this.pattern;
      const tex = this.texture;
      const tiles = this.tiles;
      const [p2r, p2g, p2b] = this.color2;

      for (let y = rect.y0; y <= rect.y1; y++) {
        for (let x = rect.x0; x <= rect.x1; x++) {
          const p = y * S + x;
          const a = (acc[p] / 255) * op;
          if (a <= 0) continue;
          const o = p * 4;
          const ba = base[o + 3] / 255;

          // Узор привязан к развёртке, а не к мазку: два прохода по одному
          // месту дают тот же рисунок, а не кашу из наложенных узоров.
          let sr = cr, sg = cg, sb = cb;
          if (tex) {
            // Картинка повторяется по развёртке заданное число раз.
            const u = ((x + 0.5) / S) * tiles;
            const v = (1 - (y + 0.5) / S) * tiles;
            const ix = ((u - Math.floor(u)) * tex.w) | 0;
            const iy = ((1 - (v - Math.floor(v))) * tex.h) | 0;
            const io = (Math.min(tex.h - 1, iy) * tex.w + Math.min(tex.w - 1, ix)) * 4;
            sr = tex.data[io]; sg = tex.data[io + 1]; sb = tex.data[io + 2];
          } else if (pat) {
            const k = patternAt(pat, (x + 0.5) / S, 1 - (y + 0.5) / S);
            sr = cr + (p2r - cr) * k;
            sg = cg + (p2g - cg) * k;
            sb = cb + (p2b - cb) * k;
          }

          if (erase) {
            // Стираем только краску: поверхность под ней всё равно не видна.
            dst[o] = base[o]; dst[o + 1] = base[o + 1]; dst[o + 2] = base[o + 2];
            dst[o + 3] = base[o + 3] * (1 - a);
          } else {
            // Обычное «краска поверх»: цвет кисти с альфой a над тем, что было.
            const outA = a + ba * (1 - a);
            const k = ba * (1 - a);
            dst[o] = (sr * a + base[o] * k) / outA;
            dst[o + 1] = (sg * a + base[o + 1] * k) / outA;
            dst[o + 2] = (sb * a + base[o + 2] * k) / outA;
            dst[o + 3] = outA * 255;

            // Поверхность подмешивается ровно с тем же покрытием, что и цвет.
            dstR[p] = baseR[p] + (matR - baseR[p]) * a;
            dstM[p] = baseM[p] + (matM - baseM[p]) * a;
            dstO[p] = baseO[p] + (matO - baseO[p]) * a;
          }
        }
      }
    }

    this.target.compositeRect(rect);
  }

  /**
   * Закрыть мазок и вернуть запись для журнала отмены (или null).
   * Правка трогает несколько буферов сразу, поэтому запись хранит их списком.
   */
  end(label = 'act.stroke') {
    this.flush();
    if (isEmptyRect(this.dirty)) return null;

    const S = this.target.size;
    const r = this.dirty;
    const part = (buf, stride, base) => ({
      buf, stride,
      before: cutRect(base, S, stride, r),
      after: cutRect(buf, S, stride, r),
    });

    const parts = this.channel === 'mask'
      ? [part(this.layer.mask, 1, this.base)]
      : [part(this.layer.rgba, 4, this.base)];

    if (this.channel === 'rgba' && this.mode === 'paint') {
      parts.push(part(this.layer.rough, 1, this.baseRough));
      parts.push(part(this.layer.metal, 1, this.baseMetal));
      parts.push(part(this.layer.opac, 1, this.baseOpac));
    }

    return { label, target: this.target, layer: this.layer, channel: this.channel, rect: r, parts };
  }
}

/**
 * Образец мазка для списка кистей.
 *
 * Считается тем же спадом и тем же зерном, что и настоящая кисть, — иначе
 * превью врало бы, и выбирать кисть по нему было бы нельзя.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} brush {hardness, flow, grain, shape, spacing, scatter}
 * @param {number[]} color RGB 0..255
 */
export function drawBrushSample(canvas, brush, color) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const acc = new Uint8Array(w * h);

  const radius = Math.max(3, h * 0.26);
  const rInv = 1 / radius;
  const hardness = brush.hardness ?? 0.7;
  const flow = brush.flow ?? 1;
  const grain = brush.grain ?? 0;
  const square = brush.shape === 'square';
  const scatter = (brush.scatter ?? 0) * radius;

  const step = Math.max(1, radius * (brush.spacing ?? 0.25));
  const pad = radius + 2;
  const steps = Math.max(2, Math.ceil((w - pad * 2) / step));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let cx = pad + (w - pad * 2) * t;
    let cy = h / 2 + Math.sin(t * Math.PI * 1.35) * (h * 0.2);
    if (scatter) {
      cx += (Math.random() * 2 - 1) * scatter;
      cy += (Math.random() * 2 - 1) * scatter;
    }

    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(h - 1, Math.ceil(cy + radius));

    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const k = square
          ? Math.max(Math.abs(dx), Math.abs(dy)) * rInv
          : Math.sqrt(dx * dx + dy * dy) * rInv;
        if (k > 1) continue;
        const p = y * w + x;
        let a = falloff(k, hardness) * flow;
        if (grain > 0) a *= 1 - grain * grainAt(p);
        a *= 255;
        if (a > acc[p]) acc[p] = a;
      }
    }
  }

  const img = ctx.createImageData(w, h);
  const d = img.data;
  const [r, g, b] = color;
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = acc[p];
  }
  ctx.clearRect(0, 0, w, h);
  ctx.putImageData(img, 0, 0);
}

/* ── Трафареты фигур ───────────────────────────────────────────── */

/** Мягкий край в один пиксель: без него у фигур лесенка. */
const edge = (d) => Math.max(0, Math.min(1, d + 0.5));

/** Прямоугольник: заливка или контур заданной толщины. */
export function rectStencil(x0, y0, x1, y1, outline = false, thickness = 3) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const t = Math.max(0.5, thickness) / 2;

  return (x, y) => {
    const inside = Math.min(x - ax, bx - x, y - ay, by - y);
    if (!outline) return edge(inside);
    // Контур — полоса вдоль границы: расстояние до края по модулю.
    const d = Math.abs(inside);
    return inside < -t ? 0 : edge(t - d);
  };
}

/** Эллипс: заливка или контур. */
export function ellipseStencil(x0, y0, x1, y1, outline = false, thickness = 3) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.max(0.5, Math.abs(x1 - x0) / 2);
  const ry = Math.max(0.5, Math.abs(y1 - y0) / 2);
  const t = Math.max(0.5, thickness) / 2;

  return (x, y) => {
    const nx = (x - cx) / rx, ny = (y - cy) / ry;
    const k = Math.sqrt(nx * nx + ny * ny);
    // Переводим «сколько единиц до границы» обратно в пиксели.
    const scale = Math.min(rx, ry);
    const dist = (1 - k) * scale;
    if (!outline) return edge(dist);
    return edge(t - Math.abs(dist));
  };
}

/**
 * Трафарет из готовой картинки — им печатается текст.
 * @param {Uint8ClampedArray} data RGBA
 */
export function imageStencil(data, w, h, x0, y0) {
  return (x, y) => {
    const ix = (x - x0) | 0, iy = (y - y0) | 0;
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return 0;
    return data[(iy * w + ix) * 4 + 3] / 255;
  };
}

/**
 * Развёртка своими руками — когда в файле её нет или она непригодна.
 *
 * Инструмент красит по текселям, поэтому развёртка для него не украшение, а
 * условие работы. Модели из интернета его сплошь и рядом не выполняют:
 * экспортёры вроде Google Poly кладут в канал UV плоскую проекцию самой
 * геометрии — значения в единицах модели, половина отрицательная. Красить по
 * такому нельзя: весь меш садится в угол атласа размером в десяток текселей.
 *
 * Здесь развёртка строится так же, как Smart UV Project в Blender: грани
 * собираются в острова по излому, каждый остров кладётся на свою плоскость,
 * поворачивается по меньшей стороне и укладывается в квадрат 0..1 с полями.
 * Масштаб у всех островов один — иначе на одной стене кисть была бы вдвое
 * крупнее, чем на соседней.
 */

import * as THREE from 'three';

const QUANT = 1e4;            // округление при сварке вершин, 0.1 мм
const ANGLE = Math.cos(Math.PI / 3);  // излом, дальше которого остров не растёт
const TURNS = 30;             // сколько поворотов перебрать в поиске меньшей рамки
// Сетка укладки по растру, клеток на сторону атласа. Замер 07.10 (доля атласа
// / время): Kian, 760 островов — 256: 58% / 0.16 с, 512: 62% / 0.36 с,
// 1024: 64% / 0.88 с; у сундука (до 100 островов на меш) 256 отстаёт от 1024
// на полтора пункта.
const RASTER_COARSE = 256;
const RASTER_FINE = 512;
const RASTER_FINE_FROM = 200; // островов, с которых доуточнять на мелкой сетке
const RASTER_STEPS = 10;      // шагов поиска масштаба для растра

/* ── Пригодна ли развёртка, которая пришла с файлом ────────────── */

/**
 * @param {THREE.BufferGeometry} geo
 * @param {number} res — разрешение пробной растеризации
 * @returns {{ok:boolean, reason?:string, share?:number, box?:number[]}}
 *   reason: 'none' — канала UV нет вовсе;
 *           'outside' — координаты вне квадрата 0..1;
 *           'tiny' — развёртка есть, но занимает считанные тексели.
 */
export function uvVerdict(geo, res = 128) {
  const uvAttr = geo.getAttribute('uv');
  const posAttr = geo.getAttribute('position');
  if (!uvAttr || !posAttr) return { ok: false, reason: 'none' };

  const uv = uvAttr.array;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i], v = uv[i + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) return { ok: false, reason: 'none' };
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  if (u0 === Infinity) return { ok: false, reason: 'none' };

  // Выход за квадрат 0..1 — это не развёртка, а чужие числа в том же канале.
  const eps = 1e-3;
  if (u0 < -eps || v0 < -eps || u1 > 1 + eps || v1 > 1 + eps) {
    return { ok: false, reason: 'outside', box: [u0, v0, u1, v1] };
  }

  // Доля покрытых текселей: развёртка может лежать внутри квадрата и всё
  // равно быть бесполезной, если жмётся в один его угол.
  const idx = geo.index ? geo.index.array : null;
  const triCount = (idx ? idx.length : posAttr.count) / 3 | 0;
  const seen = new Uint8Array(res * res);
  let covered = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    covered += rasterCount(uv, i0, i1, i2, res, seen);
  }
  const share = covered / (res * res);
  if (share < 0.02) return { ok: false, reason: 'tiny', share };
  return { ok: true, share };
}

/** Сосчитать тексели треугольника, которых ещё никто не занял. */
function rasterCount(uv, i0, i1, i2, res, seen) {
  const u0 = uv[i0 * 2] * res, v0 = (1 - uv[i0 * 2 + 1]) * res;
  const u1 = uv[i1 * 2] * res, v1 = (1 - uv[i1 * 2 + 1]) * res;
  const u2 = uv[i2 * 2] * res, v2 = (1 - uv[i2 * 2 + 1]) * res;
  const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
  if (Math.abs(den) < 1e-12) return 0;
  const inv = 1 / den;

  const x0 = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
  const x1 = Math.min(res - 1, Math.ceil(Math.max(u0, u1, u2)));
  const y0 = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
  const y1 = Math.min(res - 1, Math.ceil(Math.max(v0, v1, v2)));

  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const l0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * inv;
      const l1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * inv;
      if (l0 < 0 || l1 < 0 || 1 - l0 - l1 < 0) continue;
      const p = y * res + x;
      if (seen[p]) continue;
      seen[p] = 1; n += 1;
    }
  }
  return n;
}

/* ── Построение ────────────────────────────────────────────────── */

/**
 * Построить развёртку и вернуть НОВУЮ геометрию.
 *
 * Геометрия всегда приводится к неиндексированной: у острова свои координаты
 * на шве, а в индексированной вершина делится между островами и разрезать её
 * всё равно пришлось бы. Низкополигональной модели такое расширение не в
 * тягость, а код остаётся без развилок.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {{margin?:number}} opts margin — поле вокруг острова в долях 0..1
 * @returns {{geometry:THREE.BufferGeometry, islands:number, scale:number}}
 */
export function buildUV(geo, opts = {}) {
  const margin = opts.margin ?? 0.004;   // ~4 текселя при текстуре 1024
  const src = geo.index ? geo.toNonIndexed() : geo.clone();
  const pos = src.getAttribute('position').array;
  const triCount = (pos.length / 9) | 0;

  const normal = new Float32Array(triCount * 3);
  const area = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) faceNormal(pos, t, normal, area);

  const adj = adjacency(pos, triCount);
  const islands = cluster(triCount, normal, area, adj);

  // Каждый остров — на свою плоскость, с поворотом по меньшей рамке.
  const flat = islands.map((tris) => project(pos, tris, normal));

  // Общий масштаб подбираем так, чтобы всё влезло в квадрат: больше масштаб —
  // крупнее тексель на модели, поэтому берём наибольший, при котором укладка
  // ещё сходится. Сначала полками — это нижняя граница, она сходится всегда;
  // потом растром — он плотнее, но ищет только выше неё.
  let lo = 0, hi = 1 / Math.max(1e-6, Math.max(...flat.map((f) => Math.max(f.w, f.h))));
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (pack(flat, mid, margin)) lo = mid; else hi = mid;
  }
  // Растр ищет на грубой сетке: укладка, сошедшаяся на ней, годна и на
  // мелкой (маски грубой шире), а считается в разы быстрее. Сотни мелких
  // островов грубая клетка раздувает — их доуточняем на мелкой сетке в узкой
  // вилке над найденным. Верхняя граница: острова без полей заняли бы весь атлас.
  const shelf = lo;
  const islandArea = flat.reduce((s, f) => s + f.area, 0);
  const top = Math.max(shelf, 1 / Math.sqrt(Math.max(1e-12, islandArea)));
  let best = { scale: shelf, atlas: null };
  const search = (atlas, from, to, steps) => {
    let a = from, b = to;
    for (let i = 0; i < steps && b / a > 1.01; i++) {
      const mid = (a + b) / 2;
      if (rasterPack(flat, mid, margin, atlas)) { a = mid; if (mid > best.scale) best = { scale: mid, atlas }; }
      else b = mid;
    }
  };
  search(new Atlas(RASTER_COARSE), shelf, top, RASTER_STEPS);
  if (flat.length > RASTER_FINE_FROM) {
    search(new Atlas(RASTER_FINE), best.scale, Math.min(top, best.scale * 1.12), 4);
  }
  if (best.atlas) { lo = best.scale; rasterPack(flat, lo, margin, best.atlas); }
  else pack(flat, lo, margin);

  // Раскладываем обратно в атрибут.
  const uv = new Float32Array(src.getAttribute('position').count * 2);
  flat.forEach((f) => {
    for (let k = 0; k < f.tris.length; k++) {
      const t = f.tris[k];
      for (let c = 0; c < 3; c++) {
        const j = (k * 3 + c) * 2;
        const vert = t * 3 + c;
        const px = f.pts[j] - f.minX, py = f.pts[j + 1] - f.minY;
        uv[vert * 2] = f.x + (f.rot ? py : px) * lo;
        uv[vert * 2 + 1] = f.y + (f.rot ? f.w - px : py) * lo;
      }
    }
  });
  src.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  src.name = geo.name;
  return { geometry: src, islands: islands.length, scale: lo };
}

/** Нормаль и площадь треугольника. */
function faceNormal(pos, t, out, area) {
  const a = t * 9;
  const e1x = pos[a + 3] - pos[a], e1y = pos[a + 4] - pos[a + 1], e1z = pos[a + 5] - pos[a + 2];
  const e2x = pos[a + 6] - pos[a], e2y = pos[a + 7] - pos[a + 1], e2z = pos[a + 8] - pos[a + 2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  area[t] = len / 2;
  const d = len || 1;
  out[t * 3] = nx / d; out[t * 3 + 1] = ny / d; out[t * 3 + 2] = nz / d;
}

/**
 * Смежность по общему ребру — со сваркой вершин по месту.
 * Без сварки соседями не считались бы грани, разрезанные швом исходного
 * файла, и остров рассыпался бы на отдельные треугольники.
 */
function adjacency(pos, triCount) {
  const key = (v) => Math.round(pos[v * 3] * QUANT) + ',' +
                     Math.round(pos[v * 3 + 1] * QUANT) + ',' +
                     Math.round(pos[v * 3 + 2] * QUANT);
  const ids = new Int32Array(triCount * 3);
  const map = new Map();
  let next = 0;
  for (let v = 0; v < triCount * 3; v++) {
    const k = key(v);
    let id = map.get(k);
    if (id === undefined) { id = next++; map.set(k, id); }
    ids[v] = id;
  }

  const adj = new Int32Array(triCount * 3).fill(-1);
  const open = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = ids[t * 3 + e], b = ids[t * 3 + (e + 1) % 3];
      const k = a < b ? a + ':' + b : b + ':' + a;
      const prev = open.get(k);
      if (prev === undefined) { open.set(k, (t << 2) | e); continue; }
      const pt = prev >> 2, pe = prev & 3;
      adj[t * 3 + e] = pt;
      adj[pt * 3 + pe] = t;
      open.delete(k);
    }
  }
  return adj;
}

/**
 * Острова: от самой крупной свободной грани разливаемся по соседям, пока
 * их нормаль не отвернулась от затравки дальше порога. Затравка берётся
 * неподвижной, а не скользящим средним: иначе остров уползает по кривой
 * поверхности и в конце разворачивается почти вбок.
 */
function cluster(triCount, normal, area, adj) {
  const order = [...Array(triCount).keys()].sort((a, b) => area[b] - area[a]);
  const taken = new Uint8Array(triCount);
  const islands = [];

  for (const seed of order) {
    if (taken[seed]) continue;
    const nx = normal[seed * 3], ny = normal[seed * 3 + 1], nz = normal[seed * 3 + 2];
    const tris = [seed];
    taken[seed] = 1;
    const stack = [seed];
    while (stack.length) {
      const t = stack.pop();
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || taken[n]) continue;
        const dot = nx * normal[n * 3] + ny * normal[n * 3 + 1] + nz * normal[n * 3 + 2];
        if (dot < ANGLE) continue;
        taken[n] = 1;
        tris.push(n);
        stack.push(n);
      }
    }
    islands.push(tris);
  }
  return islands;
}

/** Остров на плоскость своей затравки, с поворотом по меньшей рамке. */
function project(pos, tris, normal) {
  const s = tris[0];
  const nx = normal[s * 3], ny = normal[s * 3 + 1], nz = normal[s * 3 + 2];

  // Пара осей в плоскости: любая, лишь бы не вдоль нормали.
  let ax = 0, ay = 0, az = 0;
  if (Math.abs(nx) < 0.9) ax = 1; else ay = 1;
  let tx = ay * nz - az * ny, ty = az * nx - ax * nz, tz = ax * ny - ay * nx;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;

  const pts = new Float64Array(tris.length * 6);
  for (let k = 0; k < tris.length; k++) {
    const a = tris[k] * 9;
    for (let c = 0; c < 3; c++) {
      const x = pos[a + c * 3], y = pos[a + c * 3 + 1], z = pos[a + c * 3 + 2];
      pts[(k * 3 + c) * 2] = x * tx + y * ty + z * tz;
      pts[(k * 3 + c) * 2 + 1] = x * bx + y * by + z * bz;
    }
  }

  // Поворот, при котором рамка острова меньше: так в атлас влезает больше.
  let best = { a: 0, w: Infinity, h: Infinity, area: Infinity, minX: 0, minY: 0 };
  for (let i = 0; i < TURNS; i++) {
    const ang = (Math.PI / 2) * (i / TURNS);
    const c = Math.cos(ang), s2 = Math.sin(ang);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j < pts.length; j += 2) {
      const x = pts[j] * c - pts[j + 1] * s2;
      const y = pts[j] * s2 + pts[j + 1] * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const w = x1 - x0, h = y1 - y0;
    if (w * h < best.area) best = { a: ang, w, h, area: w * h, minX: x0, minY: y0 };
  }

  const c = Math.cos(best.a), s2 = Math.sin(best.a);
  for (let j = 0; j < pts.length; j += 2) {
    const x = pts[j] * c - pts[j + 1] * s2;
    const y = pts[j] * s2 + pts[j + 1] * c;
    pts[j] = x; pts[j + 1] = y;
  }

  // Площадь на плоскости — для верхней границы масштаба при укладке.
  let area = 0;
  for (let j = 0; j < pts.length; j += 6) {
    area += Math.abs((pts[j + 2] - pts[j]) * (pts[j + 5] - pts[j + 1]) -
                     (pts[j + 4] - pts[j]) * (pts[j + 3] - pts[j + 1])) / 2;
  }

  return { tris, pts, area, minX: best.minX, minY: best.minY, w: best.w, h: best.h, x: 0, y: 0, rot: 0 };
}

/* ── Укладка по растру ─────────────────────────────────────────── */

/**
 * Остров при данном масштабе и повороте — маской клеток сетки укладки.
 * Клетка занята, если треугольник её хоть краем задевает: маска шире острова,
 * а не уже, и соседи по атласу не залезут на его тексели.
 * rot 1 — поворот на 90° (без отражения: x' = y, y' = W − x).
 */
function islandMask(f, scale, rot, R) {
  const k = scale * R;
  const W = f.w;
  const n = f.pts.length / 2;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const px = f.pts[i * 2] - f.minX, py = f.pts[i * 2 + 1] - f.minY;
    xs[i] = (rot ? py : px) * k;
    ys[i] = (rot ? W - px : py) * k;
  }
  const mw = Math.floor((rot ? f.h : f.w) * k) + 1;
  const mh = Math.floor((rot ? f.w : f.h) * k) + 1;
  const bits = new Uint8Array(mw * mh);

  // Треугольник ∩ полоса строки [j, j+1] — выпуклый кусок; его пределы по x
  // дают вершины внутри полосы и пересечения рёбер с её краями.
  for (let t = 0; t < n; t += 3) {
    const j0 = Math.max(0, Math.floor(Math.min(ys[t], ys[t + 1], ys[t + 2])));
    const j1 = Math.min(mh - 1, Math.floor(Math.max(ys[t], ys[t + 1], ys[t + 2])));
    for (let j = j0; j <= j1; j++) {
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < 3; c++) {
        const a = t + c, b = t + (c + 1) % 3;
        const ya = ys[a], yb = ys[b];
        if (ya >= j && ya <= j + 1) { if (xs[a] < lo) lo = xs[a]; if (xs[a] > hi) hi = xs[a]; }
        for (const yl of [j, j + 1]) {
          if ((ya - yl) * (yb - yl) >= 0 || ya === yb) continue;
          const x = xs[a] + (xs[b] - xs[a]) * (yl - ya) / (yb - ya);
          if (x < lo) lo = x; if (x > hi) hi = x;
        }
      }
      if (lo > hi) continue;
      const c0 = Math.max(0, Math.floor(lo)), c1 = Math.min(mw - 1, Math.floor(hi));
      bits.fill(1, j * mw + c0, j * mw + c1 + 1);
    }
  }

  // Маска — отрезками по строкам: проверка места идёт отрезками, не клетками.
  const runs = [];                 // [строка, начало, конец] подряд
  const rowLen = new Int32Array(mh);   // самый длинный отрезок строки
  for (let j = 0; j < mh; j++) {
    let x = 0;
    while (x < mw) {
      if (!bits[j * mw + x]) { x++; continue; }
      const a = x;
      while (x < mw && bits[j * mw + x]) x++;
      runs.push(j, a, x - 1);
      if (x - a > rowLen[j]) rowLen[j] = x - a;
    }
  }
  return { mw, mh, runs, rowLen, rot, last: 0 };
}

/**
 * Атлас укладки: занятость клеток и для каждой строки «где следующая занятая»
 * и «где следующая свободная» — по ним проверка места перепрыгивает целые
 * занятые куски, а не идёт клетка за клеткой.
 */
class Atlas {
  constructor(R) {
    this.R = R;
    this.occ = new Uint8Array(R * R);
    this.nextOcc = new Int32Array(R * R);
    this.nextFree = new Int32Array(R * R);
    this.maxRun = new Int32Array(R);           // самый длинный свободный кусок строки
    this.lo = new Int32Array(R);               // пределы правки по строкам в put()
    this.hi = new Int32Array(R);
    this.emptyRow = Int32Array.from({ length: R }, (_, x) => x);
  }

  /** Пустой атлас. Буферы те же — их выделение дороже самой укладки. */
  reset() {
    const R = this.R;
    this.occ.fill(0);
    this.nextOcc.fill(R);
    for (let y = 0; y < R; y++) this.nextFree.set(this.emptyRow, y * R);
    this.maxRun.fill(R);
  }

  /**
   * Строка после того, как в ней заняли [a, b]. Правее b ничего не
   * поменялось; левее — идём, пока новые значения не совпадут со старыми.
   */
  _row(y, a, b) {
    const R = this.R, o = y * R;
    let occAt = b + 1 < R ? this.nextOcc[o + b + 1] : R;
    let freeAt = b + 1 < R ? this.nextFree[o + b + 1] : R;
    for (let x = b; x >= 0; x--) {
      if (this.occ[o + x]) occAt = x; else freeAt = x;
      if (x < a && this.nextOcc[o + x] === occAt && this.nextFree[o + x] === freeAt) break;
      this.nextOcc[o + x] = occAt;
      this.nextFree[o + x] = freeAt;
    }
    // Самый длинный свободный кусок — прыжками по кускам, а не по клеткам.
    let best = 0, x = this.nextFree[o];
    while (x < R) {
      const end = this.nextOcc[o + x];
      if (end - x > best) best = end - x;
      x = end < R ? this.nextFree[o + end] : R;
    }
    this.maxRun[y] = best;
  }

  /** Встаёт ли маска в (x, y)? Да — -1; нет — x, с которого искать дальше. */
  test(m, x, y) {
    const R = this.R, runs = m.runs, n = runs.length;
    // С отрезка, на котором споткнулись в прошлый раз: рядом он же и мешает.
    for (let k = 0, i = m.last; k < n; k += 3, i = i + 3 < n ? i + 3 : 0) {
      const o = (y + runs[i]) * R;
      const a = x + runs[i + 1], b = x + runs[i + 2];
      const hit = this.nextOcc[o + a];
      if (hit <= b) { m.last = i; return this.nextFree[o + hit] - runs[i + 1]; }
    }
    return -1;
  }

  /** Есть ли в каждой строке под маской свободный кусок нужной длины. */
  rowsFit(m, y) {
    const rowLen = m.rowLen, maxRun = this.maxRun;
    for (let j = 0; j < rowLen.length; j++) if (maxRun[y + j] < rowLen[j]) return false;
    return true;
  }

  /** Занять место маски с полем pad клеток вокруг. */
  put(m, x, y, pad) {
    const R = this.R, runs = m.runs, lo = this.lo, hi = this.hi;
    const ya = Math.max(0, y - pad), yb = Math.min(R - 1, y + m.mh - 1 + pad);
    for (let yy = ya; yy <= yb; yy++) { lo[yy] = R; hi[yy] = -1; }
    for (let i = 0; i < runs.length; i += 3) {
      const a = Math.max(0, x + runs[i + 1] - pad), b = Math.min(R - 1, x + runs[i + 2] + pad);
      const y0 = Math.max(0, y + runs[i] - pad), y1 = Math.min(R - 1, y + runs[i] + pad);
      for (let yy = y0; yy <= y1; yy++) {
        this.occ.fill(1, yy * R + a, yy * R + b + 1);
        if (a < lo[yy]) lo[yy] = a;
        if (b > hi[yy]) hi[yy] = b;
      }
    }
    for (let yy = ya; yy <= yb; yy++) if (hi[yy] >= 0) this._row(yy, lo[yy], hi[yy]);
  }

  /** Первое место снизу вверх, слева направо; null — некуда. */
  find(m, edge) {
    const R = this.R;
    for (let y = edge; y + m.mh <= R - edge; y++) {
      if (!this.rowsFit(m, y)) continue;
      let x = edge;
      while (x + m.mw <= R - edge) {
        const next = this.test(m, x, y);
        if (next < 0) return { x, y };
        x = Math.max(x + 1, next);
      }
    }
    return null;
  }
}

/**
 * Укладка по растру: острова от крупных к мелким, каждый — в первое место
 * снизу, где его маска не задевает занятого, из двух поворотов — то, что
 * ниже. Мелкие острова садятся в выемки крупных, а не в отдельную рамку,
 * как у полок. Возвращает false, если при этом масштабе не влезло.
 */
function rasterPack(flat, scale, margin, atlas) {
  const R = atlas.R;
  const pad = Math.max(1, Math.round(margin * R));
  const edge = Math.ceil(pad / 2);
  atlas.reset();
  const order = [...flat].sort((a, b) => b.w * b.h - a.w * a.h);
  for (const f of order) {
    let best = null;
    for (const rot of [0, 1]) {
      const m = islandMask(f, scale, rot, R);
      if (m.mw + edge * 2 > R || m.mh + edge * 2 > R) continue;
      const at = atlas.find(m, edge);
      if (at && (!best || at.y < best.at.y || (at.y === best.at.y && at.x < best.at.x))) best = { m, at };
    }
    if (!best) return false;
    atlas.put(best.m, best.at.x, best.at.y, pad);
    f.x = best.at.x / R; f.y = best.at.y / R; f.rot = best.m.rot;
  }
  return true;
}

/**
 * Укладка полками: острова по убыванию высоты кладём в ряд, ряд кончился —
 * начинаем следующий выше. Возвращает false, если при этом масштабе не влезло.
 */
function pack(flat, scale, margin) {
  const order = [...flat].sort((a, b) => b.h - a.h);
  let shelfY = margin, shelfH = 0, penX = margin;
  for (const f of order) {
    const w = f.w * scale, h = f.h * scale;
    if (w + margin * 2 > 1 || h + margin * 2 > 1) return false;
    if (penX + w + margin > 1) {           // полка кончилась
      shelfY += shelfH + margin;
      shelfH = 0;
      penX = margin;
    }
    if (shelfY + h + margin > 1) return false;
    f.x = penX; f.y = shelfY; f.rot = 0;
    penX += w + margin;
    if (h > shelfH) shelfH = h;
  }
  return true;
}

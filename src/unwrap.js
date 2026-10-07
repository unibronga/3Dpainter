/**
 * Развёртка своими руками — когда в файле её нет или она непригодна.
 *
 * Инструмент красит по текселям, поэтому развёртка для него не украшение, а
 * условие работы. Модели из интернета его сплошь и рядом не выполняют:
 * экспортёры вроде Google Poly кладут в канал UV плоскую проекцию самой
 * геометрии — значения в единицах модели, половина отрицательная. Красить по
 * такому нельзя: весь меш садится в угол атласа размером в десяток текселей.
 *
 * Развёртка строится по деталям. Деталь — связная оболочка модели: штаны,
 * куртка, лицо, сапог — у сгенерированных персонажей это отдельные куски
 * одного меша. Деталь режется на как можно меньше островов: острова растут
 * по излому с широким допуском и разгибаются на плоскость конформно
 * (`lscm.js`), а где развёртка выходит негодной — режутся мельче. Острова
 * одной детали укладываются рядом друг с другом: деталь лежит на холсте
 * одним куском, а не осколками по всему квадрату. Масштаб у всех островов
 * один — иначе на одной стене кисть была бы вдвое крупнее, чем на соседней.
 */

import * as THREE from 'three';
import { flattenChart } from './lscm.js';

const QUANT = 1e4;            // округление при сварке вершин, 0.1 мм
const TURNS = 30;             // сколько поворотов перебрать в поиске меньшей рамки
// Допуски роста острова, от широкого к узкому: остров, развёртка которого
// вышла негодной, перерастает с допуском поуже. Последняя ступень — плоская
// проекция с прежним изломом 60°: она годна всегда.
const CONES = [80, 55, 35].map((d) => Math.cos(d * Math.PI / 180));
const PLANAR = Math.cos(Math.PI / 3);
// Остров мельче этой доли детали пробует прирасти к соседу: обрезки по три
// треугольника и рвали лицо в осколки. Замер 07.10 на модели из Tripo
// (островов / доля атласа): 0.06 — 206 / 55%, 0.25 — 138 / 53%, 0.5 — 134 / 54%
// при вдвое большем разбросе деталей.
const SMALL_SHARE = 0.25;
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
 * @returns {{geometry:THREE.BufferGeometry, islands:number, parts:number, scale:number}}
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

  // Детали и острова каждой — группой: острова группы ложатся рядом.
  const ctx = { pos, normal, area, adj, mark: new Int32Array(triCount).fill(-1), stamp: 0 };
  const groups = shells(triCount, adj).map((tris) => chartsOfShell(ctx, tris));
  const flat = groups.flat();

  // Общий масштаб подбираем так, чтобы всё влезло в квадрат: больше масштаб —
  // крупнее тексель на модели, поэтому берём наибольший, при котором укладка
  // ещё сходится. Растр ищет на грубой сетке: укладка, сошедшаяся на ней,
  // годна и на мелкой (маски грубой шире), а считается в разы быстрее.
  // Сотни мелких островов грубая клетка раздувает — их доуточняем на мелкой
  // сетке в узкой вилке над найденным.
  const islandArea = flat.reduce((s, f) => s + f.area, 0);
  const top = 1 / Math.sqrt(Math.max(1e-12, islandArea));   // острова без полей заняли бы весь атлас
  let best = { scale: 0, atlas: null };
  const coarse = new Atlas(RASTER_COARSE);
  // Нижняя граница — откуда укладка уже сходится.
  let from = top * 0.6;
  for (let i = 0; i < 8 && !packParts(groups, from, margin, coarse); i++) from *= 0.7;
  if (packParts(groups, from, margin, coarse)) {
    best = { scale: from, atlas: coarse };
    const search = (atlas, a, b, steps) => {
      for (let i = 0; i < steps && b / a > 1.01; i++) {
        const mid = (a + b) / 2;
        if (packParts(groups, mid, margin, atlas)) { a = mid; if (mid > best.scale) best = { scale: mid, atlas }; }
        else b = mid;
      }
    };
    search(coarse, from, Math.max(from, top), RASTER_STEPS);
    if (flat.length > RASTER_FINE_FROM) {
      search(new Atlas(RASTER_FINE), best.scale, Math.min(top, best.scale * 1.12), 4);
    }
  }
  let scale;
  if (best.atlas) { scale = best.scale; packParts(groups, scale, margin, best.atlas); }
  else {
    // Укладка не сошлась ни при каком масштабе (не бывало, но без развёртки
    // красить нечем) — полками по островам, без деталей.
    let lo = 0, hi = 1 / Math.max(1e-6, Math.max(...flat.map((f) => Math.max(f.w, f.h))));
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (pack(flat, mid, margin)) lo = mid; else hi = mid; }
    pack(flat, lo, margin);
    scale = lo;
  }

  // Раскладываем обратно в атрибут.
  const uv = new Float32Array(src.getAttribute('position').count * 2);
  flat.forEach((f) => {
    for (let k = 0; k < f.tris.length; k++) {
      const t = f.tris[k];
      for (let c = 0; c < 3; c++) {
        const j = (k * 3 + c) * 2;
        const vert = t * 3 + c;
        const px = f.pts[j] - f.minX, py = f.pts[j + 1] - f.minY;
        uv[vert * 2] = f.x + (f.rot ? py : px) * scale;
        uv[vert * 2 + 1] = f.y + (f.rot ? f.w - px : py) * scale;
      }
    }
  });
  src.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  src.name = geo.name;
  return { geometry: src, islands: flat.length, parts: groups.length, scale };
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

/** Детали: связные оболочки по общим рёбрам. */
function shells(triCount, adj) {
  const seen = new Uint8Array(triCount);
  const out = [];
  for (let s = 0; s < triCount; s++) {
    if (seen[s]) continue;
    const tris = [s];
    seen[s] = 1;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n >= 0 && !seen[n]) { seen[n] = 1; tris.push(n); }
      }
    }
    out.push(tris);
  }
  return out;
}

/**
 * Острова в пределах набора треугольников: от самой крупной свободной грани
 * разливаемся по соседям, пока их нормаль не отвернулась от затравки дальше
 * допуска. Затравка неподвижна, а не скользящее среднее: иначе остров
 * уползает по кривой поверхности и в конце разворачивается почти вбок.
 */
function grow(ctx, tris, cosLimit) {
  const { normal, area, adj, mark } = ctx;
  const id = ++ctx.stamp;               // «свой» набор помечен этим номером
  for (const t of tris) mark[t] = id;
  const order = [...tris].sort((a, b) => area[b] - area[a]);
  const out = [];
  for (const seed of order) {
    if (mark[seed] !== id) continue;
    const nx = normal[seed * 3], ny = normal[seed * 3 + 1], nz = normal[seed * 3 + 2];
    const chart = [seed];
    mark[seed] = -1;
    for (let i = 0; i < chart.length; i++) {
      const t = chart[i];
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || mark[n] !== id) continue;
        if (nx * normal[n * 3] + ny * normal[n * 3 + 1] + nz * normal[n * 3 + 2] < cosLimit) continue;
        mark[n] = -1;
        chart.push(n);
      }
    }
    out.push(chart);
  }
  return out;
}

/** Развернуть остров конформно; негодный — null. */
function tryFlat(ctx, tris) {
  const { pos, normal, area } = ctx;
  let ax = 0, ay = 0, az = 0;
  for (const t of tris) { ax += normal[t * 3] * area[t]; ay += normal[t * 3 + 1] * area[t]; az += normal[t * 3 + 2] * area[t]; }
  let l = Math.hypot(ax, ay, az);
  if (l < 1e-12) { ax = normal[tris[0] * 3]; ay = normal[tris[0] * 3 + 1]; az = normal[tris[0] * 3 + 2]; l = 1; }
  const r = flattenChart(pos, tris, [ax / l, ay / l, az / l]);
  return r.ok ? orient(tris, r.pts) : null;
}

/**
 * Острова одной детали — как можно крупнее.
 * Растут с широким допуском и разгибаются конформно; негодный остров
 * перерастает с допуском поуже, на последней ступени — плоская проекция.
 * Мелкие обрезки потом пробуют прирасти к соседу.
 */
function chartsOfShell(ctx, shellTris) {
  const out = [];
  const queue = grow(ctx, shellTris, CONES[0]).map((tris) => ({ tris, level: 0 }));
  while (queue.length) {
    const { tris, level } = queue.pop();
    const f = tryFlat(ctx, tris);
    if (f) { out.push(f); continue; }
    if (level + 1 < CONES.length) {
      for (const sub of grow(ctx, tris, CONES[level + 1])) queue.push({ tris: sub, level: level + 1 });
    } else {
      for (const sub of grow(ctx, tris, PLANAR)) out.push(project(ctx.pos, sub, ctx.normal));
    }
  }
  return mergeSmall(ctx, out, shellTris.length);
}

/**
 * Обрезки — к соседу. Остров мельче доли детали прирастает к тому соседнему,
 * с которым у него больше всего общих рёбер, если вместе они разворачиваются
 * годно. Иначе остаётся как есть.
 */
function mergeSmall(ctx, charts, shellSize) {
  if (charts.length < 2) return charts;
  const { adj } = ctx;
  const small = Math.max(3, shellSize * SMALL_SHARE);
  const owner = new Map();               // треугольник → остров
  charts.forEach((c, i) => { for (const t of c.tris) owner.set(t, i); });
  const alive = charts.slice();
  const order = alive.map((c, i) => i).filter((i) => alive[i].tris.length < small)
    .sort((a, b) => alive[a].tris.length - alive[b].tris.length);
  for (const i of order) {
    const c = alive[i];
    if (!c || c.tris.length >= small) continue;
    const shared = new Map();
    for (const t of c.tris) {
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0) continue;
        const j = owner.get(n);
        if (j === undefined || j === i || !alive[j]) continue;
        shared.set(j, (shared.get(j) || 0) + 1);
      }
    }
    const cand = [...shared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    for (const [j] of cand) {
      const merged = tryFlat(ctx, alive[j].tris.concat(c.tris));
      if (!merged) continue;
      alive[j] = merged;
      alive[i] = null;
      for (const t of c.tris) owner.set(t, j);
      break;
    }
  }
  return alive.filter(Boolean);
}

/** Плоская проекция на плоскость затравки — запасная ступень. */
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
  return orient(tris, pts);
}

/** Поворот острова по меньшей рамке: так в атлас влезает больше. */
function orient(tris, pts) {
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
  /** W×H клеток; атлас развёртки — квадрат. */
  constructor(W, H = W) {
    this.W = W; this.H = H;
    this.R = W;                                 // клеток на единицу атласа
    this.occ = new Uint8Array(W * H);
    this.nextOcc = new Int32Array(W * H);
    this.nextFree = new Int32Array(W * H);
    this.maxRun = new Int32Array(H);           // самый длинный свободный кусок строки
    this.lo = new Int32Array(H);               // пределы правки по строкам в put()
    this.hi = new Int32Array(H);
    this.emptyRow = Int32Array.from({ length: W }, (_, x) => x);
  }

  /** Пустой атлас. Буферы те же — их выделение дороже самой укладки. */
  reset() {
    const W = this.W;
    this.occ.fill(0);
    this.nextOcc.fill(W);
    for (let y = 0; y < this.H; y++) this.nextFree.set(this.emptyRow, y * W);
    this.maxRun.fill(W);
  }

  /**
   * Строка после того, как в ней заняли [a, b]. Правее b ничего не
   * поменялось; левее — идём, пока новые значения не совпадут со старыми.
   */
  _row(y, a, b) {
    const R = this.W, o = y * R;
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
    const R = this.W, runs = m.runs, n = runs.length;
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
    const R = this.W, H = this.H, runs = m.runs, lo = this.lo, hi = this.hi;
    const ya = Math.max(0, y - pad), yb = Math.min(H - 1, y + m.mh - 1 + pad);
    for (let yy = ya; yy <= yb; yy++) { lo[yy] = R; hi[yy] = -1; }
    for (let i = 0; i < runs.length; i += 3) {
      const a = Math.max(0, x + runs[i + 1] - pad), b = Math.min(R - 1, x + runs[i + 2] + pad);
      const y0 = Math.max(0, y + runs[i] - pad), y1 = Math.min(H - 1, y + runs[i] + pad);
      for (let yy = y0; yy <= y1; yy++) {
        this.occ.fill(1, yy * R + a, yy * R + b + 1);
        if (a < lo[yy]) lo[yy] = a;
        if (b > hi[yy]) hi[yy] = b;
      }
    }
    for (let yy = ya; yy <= yb; yy++) if (hi[yy] >= 0) this._row(yy, lo[yy], hi[yy]);
  }

  /**
   * Ближайшее к точке (cx, cy) место, где маска встаёт, — по расстоянию от
   * середины маски. Строки перебираются от точки наружу; дальше, чем уже
   * найденное, не ищем.
   */
  findNear(m, edge, cx, cy) {
    const H = this.H, W = this.W;
    const y0 = edge, y1 = H - edge - m.mh;
    if (y1 < y0) return null;
    const yc = Math.round(cy - m.mh / 2);
    let best = null, bd = Infinity;
    for (let k = 0; ; k++) {
      const dy = (k + 1) >> 1;
      if (dy * dy >= bd) break;
      const y = k % 2 ? yc - dy : yc + dy;
      if (k > 0 && yc - dy < y0 && yc + dy > y1) break;
      if (y < y0 || y > y1) continue;
      if (!this.rowsFit(m, y)) continue;
      const ddy = (y + m.mh / 2 - cy) ** 2;
      // Левее, чем дальше уже найденного, не начинаем.
      let x = bd < Infinity ? Math.max(edge, Math.floor(cx - m.mw / 2 - Math.sqrt(bd - ddy))) : edge;
      while (x + m.mw <= W - edge) {
        const dx = x + m.mw / 2 - cx;
        if (dx > 0 && dx * dx + ddy >= bd) break;
        const next = this.test(m, x, y);
        if (next < 0) {
          const d = dx * dx + ddy;
          if (d < bd) { bd = d; best = { x, y, d }; }
          x += 1;
        } else x = Math.max(x + 1, next);
      }
    }
    return best;
  }

  /** Первое место снизу вверх, слева направо; null — некуда. */
  find(m, edge) {
    for (let y = edge; y + m.mh <= this.H - edge; y++) {
      if (!this.rowsFit(m, y)) continue;
      let x = edge;
      while (x + m.mw <= this.W - edge) {
        const next = this.test(m, x, y);
        if (next < 0) return { x, y };
        x = Math.max(x + 1, next);
      }
    }
    return null;
  }
}

/**
 * Укладка по деталям. Детали от крупных к мелким, острова детали — от
 * крупных к мелким. Первый остров детали встаёт в первое место снизу,
 * каждый следующий — в ближайшее свободное к середине уже уложенных
 * островов этой же детали: деталь собирается в одном месте атласа, а не
 * рассыпается по нему.
 *
 * Пробовали блоками: сначала острова детали плотно в свой прямоугольник,
 * потом прямоугольники в атлас. Детали выходили кусками, но потери двух
 * укладок перемножались: 41–48% атласа против 55% у одной укладки с
 * притяжением (замер 07.10, модель из Tripo и Kian).
 */
function packParts(groups, scale, margin, atlas) {
  const R = atlas.R;
  const pad = Math.max(1, Math.round(margin * R));
  const edge = Math.ceil(pad / 2);
  const area = (g) => g.reduce((s, f) => s + f.area, 0);
  const order = groups.slice().sort((a, b) => area(b) - area(a));
  atlas.reset();
  for (const g of order) {
    const charts = g.slice().sort((a, b) => b.area - a.area);
    let sx = 0, sy = 0, sw = 0;
    for (const f of charts) {
      let pick = null;
      for (const rot of [0, 1]) {
        const m = islandMask(f, scale, rot, R);
        if (m.mw + edge * 2 > R || m.mh + edge * 2 > R) continue;
        const at = sw ? atlas.findNear(m, edge, sx / sw, sy / sw) : atlas.find(m, edge);
        if (!at) continue;
        const d = sw ? at.d : at.y * R + at.x;
        if (!pick || d < pick.d) pick = { m, at, d };
      }
      if (!pick) return false;
      atlas.put(pick.m, pick.at.x, pick.at.y, pad);
      f.x = pick.at.x / R; f.y = pick.at.y / R; f.rot = pick.m.rot;
      const w = pick.m.mw * pick.m.mh;
      sx += (pick.at.x + pick.m.mw / 2) * w; sy += (pick.at.y + pick.m.mh / 2) * w; sw += w;
    }
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

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
  // ещё сходится.
  let lo = 0, hi = 1 / Math.max(1e-6, Math.max(...flat.map((f) => Math.max(f.w, f.h))));
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (pack(flat, mid, margin)) lo = mid; else hi = mid;
  }
  pack(flat, lo, margin);

  // Раскладываем обратно в атрибут.
  const uv = new Float32Array(src.getAttribute('position').count * 2);
  flat.forEach((f) => {
    for (let k = 0; k < f.tris.length; k++) {
      const t = f.tris[k];
      for (let c = 0; c < 3; c++) {
        const j = (k * 3 + c) * 2;
        const vert = t * 3 + c;
        uv[vert * 2] = f.x + (f.pts[j] - f.minX) * lo;
        uv[vert * 2 + 1] = f.y + (f.pts[j + 1] - f.minY) * lo;
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

  return { tris, pts, minX: best.minX, minY: best.minY, w: best.w, h: best.h, x: 0, y: 0 };
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
    f.x = penX; f.y = shelfY;
    penX += w + margin;
    if (h > shelfH) shelfH = h;
  }
  return true;
}

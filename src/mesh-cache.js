/**
 * Предрасчёт по мешу — всё, что нужно кисти и заливкам, считается один раз
 * при загрузке модели, а не на каждый мазок.
 *
 * Хранится в локальных координатах меша: переводить точку кисти в локальные
 * дешевле, чем гонять все вершины в мировые.
 */

const QUANT = 1e4; // округление позиций при сварке вершин (0.1 мм)

/**
 * @param {THREE.BufferGeometry} geo
 * @returns {object|null} кэш или null, если у геометрии нет UV
 */
export function buildMeshCache(geo) {
  const posAttr = geo.getAttribute('position');
  const uvAttr = geo.getAttribute('uv');
  if (!posAttr || !uvAttr) return null;

  const vertCount = posAttr.count;
  const pos = posAttr.array;
  const uv = uvAttr.array;

  // Индексы приводим к явной тройке на треугольник — дальше везде один вид.
  let idx;
  if (geo.index) {
    idx = geo.index.array;
  } else {
    idx = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) idx[i] = i;
  }
  const triCount = (idx.length / 3) | 0;

  // Оболочка треугольника: центр + радиус. Нужна для быстрой отбраковки.
  const centroid = new Float32Array(triCount * 3);
  const triRadius = new Float32Array(triCount);
  const faceNormal = new Float32Array(triCount * 3);

  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];

    const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3, gz = (az + bz + cz) / 3;
    centroid[t * 3] = gx; centroid[t * 3 + 1] = gy; centroid[t * 3 + 2] = gz;

    let r2 = 0;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      const d2 = (x - gx) ** 2 + (y - gy) ** 2 + (z - gz) ** 2;
      if (d2 > r2) r2 = d2;
    }
    triRadius[t] = Math.sqrt(r2);

    // Нормаль грани — по правилу правой руки, как считает сам Blender.
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    faceNormal[t * 3] = nx / len;
    faceNormal[t * 3 + 1] = ny / len;
    faceNormal[t * 3 + 2] = nz / len;
  }

  // Сварка вершин по позиции: на швах развёртки одна точка меша разрезана
  // на несколько вершин, а геометрически это по-прежнему одна точка.
  const weld = new Int32Array(vertCount);
  {
    const map = new Map();
    let next = 0;
    for (let v = 0; v < vertCount; v++) {
      const k = Math.round(pos[v * 3] * QUANT) + ',' +
                Math.round(pos[v * 3 + 1] * QUANT) + ',' +
                Math.round(pos[v * 3 + 2] * QUANT);
      let id = map.get(k);
      if (id === undefined) { id = next++; map.set(k, id); }
      weld[v] = id;
    }
  }

  // Две смежности с разным смыслом:
  //   adjGeom — по сварке: ходит через шов развёртки (заливка по форме);
  //   adjUV   — по индексам: шов не переходит (заливка одного острова).
  const adjGeom = buildAdjacency(triCount, idx, weld);
  const adjUV = buildAdjacency(triCount, idx, null);

  const cache = {
    geo, pos, uv, idx, vertCount, triCount,
    centroid, triRadius, faceNormal, adjGeom, adjUV,
  };
  cache.grid = buildGrid(cache);
  return cache;
}

/**
 * Смежность граней по общему ребру.
 * @param {Int32Array|null} remap — карта вершин (сварка) или null для прямых индексов
 * @returns {Int32Array} triCount*3, сосед для каждого ребра или -1
 */
function buildAdjacency(triCount, idx, remap) {
  const adj = new Int32Array(triCount * 3).fill(-1);
  const open = new Map(); // ребро без пары -> (треугольник << 2 | номер ребра)

  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      let a = idx[t * 3 + e];
      let b = idx[t * 3 + (e + 1) % 3];
      if (remap) { a = remap[a]; b = remap[b]; }
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;

      const prev = open.get(key);
      if (prev === undefined) {
        open.set(key, (t << 2) | e);
      } else {
        // Ребро нашло пару — связываем обе грани и убираем из ожидания.
        const pt = prev >> 2, pe = prev & 3;
        adj[t * 3 + e] = pt;
        adj[pt * 3 + pe] = t;
        open.delete(key);
      }
    }
  }
  return adj;
}

/**
 * Разлив по граням от стартовой: переходим ребро, только если излом меньше
 * порога. Так «залей крышу» не перетекает на стену.
 *
 * @param {number} startTri
 * @param {number} angleDeg — порог излома, 180° = вся связная оболочка
 * @param {'geom'|'uv'} mode
 * @returns {Set<number>}
 */
export function floodFaces(cache, startTri, angleDeg, mode = 'geom') {
  const adj = mode === 'uv' ? cache.adjUV : cache.adjGeom;
  const { faceNormal } = cache;
  const cosLimit = Math.cos(THREE_DEG * angleDeg);

  const out = new Set([startTri]);
  const stack = [startTri];

  while (stack.length) {
    const t = stack.pop();
    const nx = faceNormal[t * 3], ny = faceNormal[t * 3 + 1], nz = faceNormal[t * 3 + 2];

    for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e];
      if (n < 0 || out.has(n)) continue;

      if (mode === 'geom' && angleDeg < 180) {
        const dot = nx * faceNormal[n * 3] + ny * faceNormal[n * 3 + 1] + nz * faceNormal[n * 3 + 2];
        if (dot < cosLimit) continue; // излом круче порога — стоп
      }
      out.add(n);
      stack.push(n);
    }
  }
  return out;
}

const THREE_DEG = Math.PI / 180;

/**
 * Доля развёртки с наложением.
 *
 * Если две грани, далёкие друг от друга в пространстве, делят одни и те же
 * тексели, красить модель по-человечески нельзя: мазок по одной стене
 * проступит на другой. Так ведут себя коробки из примитивов и ассеты с
 * зеркальной развёрткой — предупредить об этом надо до первого мазка,
 * а не после.
 *
 * @param {number} tol — на сколько метров грани должны разойтись, чтобы
 *                       совпадение текселей считалось наложением
 * @returns {{covered:number, overlapped:number, ratio:number}}
 */
export function measureUVOverlap(cache, tol = 0.05, res = 256) {
  const { uv, idx, triCount, centroid } = cache;
  const owner = new Int32Array(res * res).fill(-1);
  let covered = 0, overlapped = 0;
  const tol2 = tol * tol;

  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    const u0 = uv[i0 * 2] * res, v0 = (1 - uv[i0 * 2 + 1]) * res;
    const u1 = uv[i1 * 2] * res, v1 = (1 - uv[i1 * 2 + 1]) * res;
    const u2 = uv[i2 * 2] * res, v2 = (1 - uv[i2 * 2 + 1]) * res;

    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-9) continue;
    const inv = 1 / den;

    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
    const maxX = Math.min(res - 1, Math.ceil(Math.max(u0, u1, u2)));
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
    const maxY = Math.min(res - 1, Math.ceil(Math.max(v0, v1, v2)));

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const l0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * inv;
        const l1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * inv;
        if (l0 < 0 || l1 < 0 || 1 - l0 - l1 < 0) continue;

        const p = y * res + x;
        const prev = owner[p];
        if (prev < 0) { owner[p] = t; covered += 1; continue; }

        const dx = centroid[t * 3] - centroid[prev * 3];
        const dy = centroid[t * 3 + 1] - centroid[prev * 3 + 1];
        const dz = centroid[t * 3 + 2] - centroid[prev * 3 + 2];
        if (dx * dx + dy * dy + dz * dz > tol2) overlapped += 1;
      }
    }
  }

  return { covered, overlapped, ratio: covered ? overlapped / covered : 0 };
}

/* ── Сетка ускорения ───────────────────────────────────────────── */

/**
 * Равномерная сетка по габариту меша: какие треугольники лежат в какой ячейке.
 *
 * Без неё каждый отпечаток кисти перебирает все треугольники модели. На демо
 * это незаметно, на уровне в двадцать тысяч треугольников — уже тормоза, а
 * отпечатков за один взмах мыши ставится десятки.
 *
 * Хранение плоское (CSR): счётчики + один общий массив индексов, без массива
 * массивов — так сборщику мусора нечего делать во время мазка.
 */
export function buildGrid(cache) {
  const { pos, idx, triCount } = cache;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i];
    if (pos[i + 1] < minY) minY = pos[i + 1];
    if (pos[i + 2] < minZ) minZ = pos[i + 2];
    if (pos[i] > maxX) maxX = pos[i];
    if (pos[i + 1] > maxY) maxY = pos[i + 1];
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
  }

  // Целимся примерно в четыре треугольника на ячейку.
  const res = Math.max(2, Math.min(48, Math.ceil(Math.cbrt(triCount / 4)) || 2));
  const pad = 1e-4;
  const sx = (maxX - minX + pad * 2) / res;
  const sy = (maxY - minY + pad * 2) / res;
  const sz = (maxZ - minZ + pad * 2) / res;

  const cellOf = (v, min, s) => Math.max(0, Math.min(res - 1, ((v - min + pad) / s) | 0));

  // Границы ячеек для каждого треугольника считаем один раз и запоминаем:
  // они нужны и на подсчёте, и на раскладке.
  const spans = new Int32Array(triCount * 6);
  const counts = new Int32Array(res * res * res + 1);

  for (let t = 0; t < triCount; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      const x = pos[v], y = pos[v + 1], z = pos[v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const a = cellOf(x0, minX, sx), b = cellOf(x1, minX, sx);
    const c = cellOf(y0, minY, sy), d = cellOf(y1, minY, sy);
    const e = cellOf(z0, minZ, sz), f = cellOf(z1, minZ, sz);
    spans.set([a, b, c, d, e, f], t * 6);

    for (let z = e; z <= f; z++)
      for (let y = c; y <= d; y++)
        for (let x = a; x <= b; x++) counts[(z * res + y) * res + x + 1] += 1;
  }

  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];

  const items = new Int32Array(counts[counts.length - 1]);
  const cursor = counts.slice(0, -1);
  for (let t = 0; t < triCount; t++) {
    const a = spans[t * 6], b = spans[t * 6 + 1];
    const c = spans[t * 6 + 2], d = spans[t * 6 + 3];
    const e = spans[t * 6 + 4], f = spans[t * 6 + 5];
    for (let z = e; z <= f; z++)
      for (let y = c; y <= d; y++)
        for (let x = a; x <= b; x++) items[cursor[(z * res + y) * res + x]++] = t;
  }

  return {
    res, minX, minY, minZ, sx, sy, sz, counts, items,
    // Метка посещения: треугольник лежит в нескольких ячейках, обрабатывать
    // его надо один раз за запрос.
    stamp: new Int32Array(triCount), gen: 0,
  };
}

/**
 * Треугольники, чьи ячейки задевает шар кисти.
 * @param {function(number):void} cb — вызывается для каждого кандидата один раз
 */
export function queryGrid(grid, cx, cy, cz, r, cb) {
  const { res, minX, minY, minZ, sx, sy, sz, counts, items, stamp } = grid;
  const gen = ++grid.gen;

  const lo = (v, min, s) => Math.max(0, Math.min(res - 1, ((v - min) / s) | 0));
  const x0 = lo(cx - r, minX, sx), x1 = lo(cx + r, minX, sx);
  const y0 = lo(cy - r, minY, sy), y1 = lo(cy + r, minY, sy);
  const z0 = lo(cz - r, minZ, sz), z1 = lo(cz + r, minZ, sz);

  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      const rowBase = (z * res + y) * res;
      for (let x = x0; x <= x1; x++) {
        const c = rowBase + x;
        for (let i = counts[c]; i < counts[c + 1]; i++) {
          const t = items[i];
          if (stamp[t] === gen) continue;
          stamp[t] = gen;
          cb(t);
        }
      }
    }
  }
}

/**
 * Треугольник под точкой развёртки — для работы прямо в UV-редакторе.
 * @returns {number} индекс треугольника или -1
 */
export function findTriangleAtUV(cache, u, v) {
  const { uv, idx, triCount } = cache;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
    const u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1];
    const u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];

    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-12) continue;
    const l0 = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / den;
    const l1 = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / den;
    if (l0 >= 0 && l1 >= 0 && 1 - l0 - l1 >= 0) return t;
  }
  return -1;
}

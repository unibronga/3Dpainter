/**
 * Конформная развёртка одного острова (LSCM, Lévy и др., 2002) и проверка,
 * годится ли она для покраски.
 *
 * Проекция на плоскость, с которой развёртка начиналась, режет кривую
 * поверхность на десятки кусков: каждый кусок может отклониться от своей
 * плоскости не больше чем на угол, иначе ляжет сплющенным. Конформная
 * развёртка разгибает поверхность, а не сплющивает: углы треугольников
 * сохраняются, и лицо или рукав ложатся одним островом. Цена — площадь
 * местами растягивается; где слишком, остров режется мельче (решает хозяин).
 *
 * Решается наименьшими квадратами: на треугольник два уравнения
 * Коши — Римана, две вершины закреплены. Система разреженная, решаем
 * сопряжёнными градиентами по нормальным уравнениям с диагональным
 * предобуславливанием, начиная с плоской проекции — с неё сходится быстро.
 */

const QUANT = 1e4;   // сварка вершин острова по месту, 0.1 мм

/**
 * @param {Float32Array} pos позиции неиндексированной геометрии
 * @param {number[]} tris треугольники острова
 * @param {number[]} axis нормаль, на плоскость которой берётся начальная
 *   проекция (и закрепление двух вершин)
 * @returns {{ok:boolean, pts?:Float64Array, reason?:string, stretch?:number}}
 *   pts — по углам треугольников (k·3 + c), в метрах, площадь как на модели
 */
export function flattenChart(pos, tris, axis, opts = {}) {
  const maxStretch = opts.maxStretch ?? 2.6;
  const T = tris.length;

  // Вершины острова — сваренные по месту: шов исходного файла внутри
  // острова не должен его разрезать.
  const ids = new Int32Array(T * 3);
  const map = new Map();
  const vx = [], vy = [], vz = [];
  for (let k = 0; k < T; k++) {
    for (let c = 0; c < 3; c++) {
      const a = tris[k] * 9 + c * 3;
      const key = Math.round(pos[a] * QUANT) + ',' + Math.round(pos[a + 1] * QUANT) + ',' + Math.round(pos[a + 2] * QUANT);
      let id = map.get(key);
      if (id === undefined) { id = vx.length; map.set(key, id); vx.push(pos[a]); vy.push(pos[a + 1]); vz.push(pos[a + 2]); }
      ids[k * 3 + c] = id;
    }
  }
  const V = vx.length;

  // Плоскость начальной проекции.
  const [nx, ny, nz] = axis;
  let ax = 0, ay = 0, az = 0;
  if (Math.abs(nx) < 0.9) ax = 1; else ay = 1;
  let tx = ay * nz - az * ny, ty = az * nx - ax * nz, tz = ax * ny - ay * nx;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  const x = new Float64Array(V * 2);
  for (let i = 0; i < V; i++) {
    x[i * 2] = vx[i] * tx + vy[i] * ty + vz[i] * tz;
    x[i * 2 + 1] = vx[i] * bx + vy[i] * by + vz[i] * bz;
  }

  // Коэффициенты: для треугольника в его собственной плоскости
  // W_j = (x_{j+2} − x_{j+1}) + i (y_{j+2} − y_{j+1}), делённые на √(2S).
  // Уравнение Σ W_j·U_j = 0 — две строки: вещественная и мнимая части.
  const coef = new Float64Array(T * 6);
  const area3 = new Float64Array(T);
  for (let k = 0; k < T; k++) {
    const i0 = ids[k * 3], i1 = ids[k * 3 + 1], i2 = ids[k * 3 + 2];
    const e1x = vx[i1] - vx[i0], e1y = vy[i1] - vy[i0], e1z = vz[i1] - vz[i0];
    const e2x = vx[i2] - vx[i0], e2y = vy[i2] - vy[i0], e2z = vz[i2] - vz[i0];
    const l1 = Math.hypot(e1x, e1y, e1z);
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    const d = Math.hypot(cx, cy, cz);          // 2S
    area3[k] = d / 2;
    if (l1 < 1e-12 || d < 1e-14) continue;     // вырожденный — без уравнения
    // Локальные координаты: x0 = (0,0), x1 = (l1, 0), x2 = (p, q).
    const p = (e2x * e1x + e2y * e1y + e2z * e1z) / l1;
    const q = d / l1;
    const X = [0, l1, p], Y = [0, 0, q];
    const s = 1 / Math.sqrt(d);
    for (let j = 0; j < 3; j++) {
      const a = (j + 1) % 3, b = (j + 2) % 3;
      coef[k * 6 + j * 2] = (X[b] - X[a]) * s;      // вещественная часть W_j
      coef[k * 6 + j * 2 + 1] = (Y[b] - Y[a]) * s;  // мнимая
    }
  }

  // Закрепляем две самые далёкие вершины — на их месте в проекции.
  let pa = 0, pb = 0, far = -1;
  for (let i = 0; i < V; i++) { const d = (vx[i] - vx[0]) ** 2 + (vy[i] - vy[0]) ** 2 + (vz[i] - vz[0]) ** 2; if (d > far) { far = d; pa = i; } }
  far = -1;
  for (let i = 0; i < V; i++) { const d = (vx[i] - vx[pa]) ** 2 + (vy[i] - vy[pa]) ** 2 + (vz[i] - vz[pa]) ** 2; if (d > far) { far = d; pb = i; } }
  const pinned = new Uint8Array(V * 2);
  pinned[pa * 2] = pinned[pa * 2 + 1] = pinned[pb * 2] = pinned[pb * 2 + 1] = 1;

  if (V > 3 && T > 1) solve(x, ids, coef, T, V, pinned, opts.iterations ?? 1500);

  // Углы треугольников — в координаты острова.
  const pts = new Float64Array(T * 6);
  for (let k = 0; k < T; k++) {
    for (let c = 0; c < 3; c++) {
      const i = ids[k * 3 + c];
      pts[(k * 3 + c) * 2] = x[i * 2];
      pts[(k * 3 + c) * 2 + 1] = x[i * 2 + 1];
    }
  }
  return judge(pts, area3, T, maxStretch);
}

/**
 * min |A·x|², закреплённые переменные не трогаем. A не собирается целиком:
 * произведения A·p и Aᵀ·r считаются по треугольникам на лету.
 */
function solve(x, ids, coef, T, V, pinned, maxIter) {
  const n = V * 2;
  const Ax = new Float64Array(T * 2);
  const mulA = (v, out) => {
    for (let k = 0; k < T; k++) {
      let re = 0, im = 0;
      for (let j = 0; j < 3; j++) {
        const i = ids[k * 3 + j], a = coef[k * 6 + j * 2], b = coef[k * 6 + j * 2 + 1];
        const u = v[i * 2], w = v[i * 2 + 1];
        re += a * u - b * w;
        im += b * u + a * w;
      }
      out[k * 2] = re; out[k * 2 + 1] = im;
    }
  };
  const mulAT = (y, out) => {
    out.fill(0);
    for (let k = 0; k < T; k++) {
      const re = y[k * 2], im = y[k * 2 + 1];
      for (let j = 0; j < 3; j++) {
        const i = ids[k * 3 + j], a = coef[k * 6 + j * 2], b = coef[k * 6 + j * 2 + 1];
        out[i * 2] += a * re + b * im;
        out[i * 2 + 1] += -b * re + a * im;
      }
    }
    for (let i = 0; i < n; i++) if (pinned[i]) out[i] = 0;
  };

  // Диагональ AᵀA — предобуславливатель Якоби.
  const diag = new Float64Array(n);
  for (let k = 0; k < T; k++) {
    for (let j = 0; j < 3; j++) {
      const i = ids[k * 3 + j], a = coef[k * 6 + j * 2], b = coef[k * 6 + j * 2 + 1];
      diag[i * 2] += a * a + b * b;
      diag[i * 2 + 1] += a * a + b * b;
    }
  }
  for (let i = 0; i < n; i++) diag[i] = diag[i] > 1e-18 && !pinned[i] ? 1 / diag[i] : 0;

  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  mulA(x, Ax);
  mulAT(Ax, r);
  for (let i = 0; i < n; i++) r[i] = -r[i];
  let rz = 0;
  for (let i = 0; i < n; i++) { z[i] = r[i] * diag[i]; p[i] = z[i]; rz += r[i] * z[i]; }
  const r0 = Math.sqrt(rz) || 1;
  for (let it = 0; it < maxIter && rz > 1e-30; it++) {
    mulA(p, Ax);
    let pAp = 0;
    for (let k = 0; k < T * 2; k++) pAp += Ax[k] * Ax[k];
    if (pAp <= 1e-30) break;
    mulAT(Ax, Ap);
    const alpha = rz / pAp;
    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      z[i] = r[i] * diag[i];
      rzNew += r[i] * z[i];
    }
    if (Math.sqrt(rzNew) < r0 * 1e-7) break;
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
}

/**
 * Годится ли развёртка острова:
 *   - ни одного вывернутого треугольника (вывернутый — это наложение);
 *   - остров не налегает сам на себя (без вывертов бывает у длинных колец);
 *   - площадь растянута умеренно: у 80% площади модели отношение
 *     «площадь в развёртке / на модели» в пределах maxStretch раз —
 *     иначе в одном месте кисть будет вдвое крупнее, чем в соседнем.
 * Годную масштабирует так, чтобы площадь в развёртке равнялась площади на
 * модели: тогда у всех островов одна плотность текселей.
 */
function judge(pts, area3, T, maxStretch) {
  const uvA = new Float64Array(T);
  let pos = 0, neg = 0, sumUV = 0, sum3 = 0;
  for (let k = 0; k < T; k++) {
    const a = k * 6;
    const s = ((pts[a + 2] - pts[a]) * (pts[a + 5] - pts[a + 1]) - (pts[a + 4] - pts[a]) * (pts[a + 3] - pts[a + 1])) / 2;
    uvA[k] = s;
    if (area3[k] < 1e-12) continue;
    if (s > 0) pos += area3[k]; else if (s < 0) neg += area3[k];
    sumUV += Math.abs(s); sum3 += area3[k];
  }
  if (!(sumUV > 0) || !(sum3 > 0)) return { ok: false, reason: 'degenerate' };
  // Все треугольники должны лечь одной стороной. Если все наоборот — остров
  // зеркальный целиком: отражаем, это не порок.
  const flip = neg > pos;
  let flipped = 0;
  for (let k = 0; k < T; k++) if (area3[k] >= 1e-12 && (flip ? uvA[k] > 0 : uvA[k] < 0) && Math.abs(uvA[k]) > sumUV * 1e-9) flipped++;
  if (flipped) return { ok: false, reason: 'flip' };
  if (flip) for (let i = 0; i < pts.length; i += 2) pts[i] = -pts[i];

  // Растяжение — по квантилям площади модели, а не по худшему треугольнику:
  // щепка в два миллиметра погоду не делает.
  const k0 = sumUV / sum3;
  const order = [];
  for (let k = 0; k < T; k++) if (area3[k] >= 1e-12) order.push(k);
  order.sort((a, b) => Math.abs(uvA[a]) / area3[a] - Math.abs(uvA[b]) / area3[b]);
  let acc = 0, q10 = 0, q90 = 0;
  for (const k of order) {
    const r = Math.abs(uvA[k]) / area3[k] / k0;
    acc += area3[k];
    if (!q10 && acc >= sum3 * 0.1) q10 = r;
    if (!q90 && acc >= sum3 * 0.9) { q90 = r; break; }
  }
  const stretch = q10 > 0 ? q90 / q10 : Infinity;
  if (stretch > maxStretch) return { ok: false, reason: 'stretch', stretch };

  if (selfOverlap(pts, T)) return { ok: false, reason: 'overlap', stretch };

  const s = Math.sqrt(sum3 / sumUV);
  for (let i = 0; i < pts.length; i++) pts[i] *= s;
  return { ok: true, pts, stretch };
}

/** Налегает ли остров сам на себя: центр клетки сетки внутри двух треугольников. */
function selfOverlap(pts, T) {
  if (T < 4) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i]; if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1]; if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  const R = 160;
  const k = R / Math.max(x1 - x0, y1 - y0, 1e-12);
  const W = Math.ceil((x1 - x0) * k) + 1, H = Math.ceil((y1 - y0) * k) + 1;
  const owner = new Int32Array(W * H).fill(-1);
  let covered = 0, twice = 0;
  for (let t = 0; t < T; t++) {
    const a = t * 6;
    const u0 = (pts[a] - x0) * k, v0 = (pts[a + 1] - y0) * k;
    const u1 = (pts[a + 2] - x0) * k, v1 = (pts[a + 3] - y0) * k;
    const u2 = (pts[a + 4] - x0) * k, v2 = (pts[a + 5] - y0) * k;
    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-12) continue;
    const inv = 1 / den;
    for (let y = Math.max(0, Math.floor(Math.min(v0, v1, v2))); y <= Math.min(H - 1, Math.ceil(Math.max(v0, v1, v2))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(u0, u1, u2))); x <= Math.min(W - 1, Math.ceil(Math.max(u0, u1, u2))); x++) {
        const px = x + 0.5, py = y + 0.5;
        const l0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) * inv;
        const l1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) * inv;
        const l2 = 1 - l0 - l1;
        // Строго внутри: центр на общем ребре соседей — не наложение.
        if (l0 <= 1e-6 || l1 <= 1e-6 || l2 <= 1e-6) continue;
        const p = y * W + x;
        if (owner[p] < 0) { owner[p] = t; covered++; } else twice++;
      }
    }
  }
  return twice > Math.max(2, covered * 0.002);
}

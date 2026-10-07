/**
 * Аппликация — картинка с прозрачностью, наложенная на модель.
 *
 * Картинка ставится поверх панели четырьмя углами (свободно, с перспективой)
 * и впекается в слой той же проекцией, что фигуры и текст: на модели — с
 * экрана, в развёртке — прямо по текселям. Здесь всё, что про саму картинку:
 * чтение файла, уровни детализации, отображение «углы → картинка»,
 * трафарет с цветом, правка углов и слой поверх панели.
 *
 * Углы всегда по порядку: левый верхний, правый верхний, правый нижний,
 * левый нижний — по картинке, как она лежит в файле.
 */

/** Больше стороны атласа картинке быть незачем: тексель её не покажет. */
const MAX_SIDE = 2048;

/* ── Картинка ──────────────────────────────────────────────────── */

/**
 * Прочитать файл картинки и построить уровни детализации.
 *
 * Уровни нужны, потому что картинку часто кладут мельче её самой: снимок в
 * 2000 пикселей на нашивку в сотню текселей. Без них каждый тексель брал бы
 * одну случайную точку картинки, и на месте рисунка выходила бы рябь.
 * Уменьшает холст браузера — он фильтрует с учётом прозрачности сам.
 *
 * @returns {Promise<{name, w, h, url, levels: {w, h, data}[]}>}
 */
export async function loadDecalImage(file) {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  let w = Math.max(1, Math.round(bitmap.width * k));
  let h = Math.max(1, Math.round(bitmap.height * k));

  let src = document.createElement('canvas');
  src.width = w; src.height = h;
  const ctx = src.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const canvas = src;               // полный размер — для проекции на видеокарте
  const url = src.toDataURL('image/png');

  const levels = [{ w, h, data: ctx.getImageData(0, 0, w, h).data }];
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, nw, nh);
    levels.push({ w: nw, h: nh, data: cx.getImageData(0, 0, nw, nh).data });
    src = c; w = nw; h = nh;
  }
  return { name: file.name, w: levels[0].w, h: levels[0].h, url, canvas, levels };
}

/* ── Углы → картинка ───────────────────────────────────────────── */

/**
 * Проективное отображение единичного квадрата картинки на четырёхугольник
 * (Heckbert): x = (a·u + b·v + c) / (g·u + h·v + 1), y — так же через d, e, f.
 * Перспектива здесь честная: четыре угла задают её однозначно.
 */
export function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0];
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
          p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h];
}

/**
 * Обратное отображение: точка → (u, v) картинки, матрица 3×3 построчно.
 * Присоединённая к [[a b c] [d e f] [g h 1]] — обратная с точностью до
 * множителя; множитель в проективных координатах сокращается, но не его
 * знак: по знаку третьей координаты отсекается «за горизонтом». Поэтому
 * знак выравниваем так, чтобы в середине картинки она была положительной, —
 * иначе картинка, вывернутая углом наизнанку, пропадала бы целиком.
 */
export function quadInverse(q) {
  const [a, b, c, d, e, f, g, h] = squareToQuad(q);
  const m = [e - f * h, c * h - b, b * f - c * e,
             f * g - d, a - c * g, c * d - a * f,
             d * h - e * g, b * g - a * h, a * e - b * d];
  // Середина картинки (u = v = ½) в координатах углов.
  const w = g * 0.5 + h * 0.5 + 1;
  const mx = (a * 0.5 + b * 0.5 + c) / w, my = (d * 0.5 + e * 0.5 + f) / w;
  if (m[6] * mx + m[7] * my + m[8] < 0) for (let i = 0; i < 9; i++) m[i] = -m[i];
  return m;
}

function quadToSquare(q) {
  const [A, B, C, D, E, F, G, H, I] = quadInverse(q);
  return (x, y, out) => {
    const w = G * x + H * y + I;
    out.u = (A * x + B * y + C) / w;
    out.v = (D * x + E * y + F) / w;
    return w;
  };
}

/** CSS-преобразование картинки w×h в четырёхугольник — для слоя поверх. */
export function quadMatrix3d(w, h, q) {
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q);
  const m = [a / w, d / w, 0, g / w,  b / h, e / h, 0, hh / h,  0, 0, 1, 0,  c, f, 0, 1];
  return `matrix3d(${m.join(',')})`;
}

/* ── Трафарет ──────────────────────────────────────────────────── */

/**
 * Трафарет аппликации: покрытие — прозрачность картинки в точке, цвет —
 * её цвет. Координаты точек — в тех же единицах, что и углы.
 *
 * Уровень детализации берётся по тому, сколько пикселей картинки приходится
 * на тексель: k — единиц на тексель у текущего треугольника (на модели —
 * пикселей экрана, в развёртке — 1).
 */
export function decalStencil(img, quad) {
  const toUV = quadToSquare(quad);
  const area = Math.abs(polyArea(quad)) || 1;
  // Пикселей картинки на единицу координат — в среднем по четырёхугольнику.
  const imgPerUnit = Math.sqrt((img.w * img.h) / area);
  const top = img.levels.length - 1;
  const uv = { u: 0, v: 0 };

  const fn = (x, y, out, k = 1) => {
    if (toUV(x, y, uv) <= 0) return 0;            // за горизонтом перспективы
    const u = uv.u, v = uv.v;
    if (u < -0.01 || v < -0.01 || u > 1.01 || v > 1.01) return 0;

    const perTexel = imgPerUnit * k;               // пикселей картинки на тексель
    const L = Math.max(0, Math.min(top, Math.floor(Math.log2(Math.max(1, perTexel)))));
    const lv = img.levels[L];
    const step = Math.max(1, perTexel / (1 << L)); // пикселей уровня на тексель

    // Мягкий край по контуру рамки — в один тексель, как у фигур.
    const edge = Math.min(u, 1 - u) * lv.w, edgeV = Math.min(v, 1 - v) * lv.h;
    const cover = Math.max(0, Math.min(1, Math.min(edge, edgeV) / step + 0.5));
    if (cover <= 0) return 0;

    // Билинейно, с весом по прозрачности: иначе вокруг рисунка вылезла бы
    // тёмная кайма — у прозрачных пикселей цвет чёрный.
    const fx = Math.min(lv.w - 1, Math.max(0, u * lv.w - 0.5));
    const fy = Math.min(lv.h - 1, Math.max(0, v * lv.h - 0.5));
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = Math.min(lv.w - 1, x0 + 1), y1 = Math.min(lv.h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const d = lv.data;
    let r = 0, g = 0, b = 0, a = 0;
    const tap = (px, py, w) => {
      const o = (py * lv.w + px) * 4;
      const wa = w * d[o + 3];
      r += d[o] * wa; g += d[o + 1] * wa; b += d[o + 2] * wa; a += wa;
    };
    tap(x0, y0, (1 - tx) * (1 - ty)); tap(x1, y0, tx * (1 - ty));
    tap(x0, y1, (1 - tx) * ty);       tap(x1, y1, tx * ty);
    if (a <= 0) return 0;
    out[0] = r / a; out[1] = g / a; out[2] = b / a;
    return (a / 255) * cover;
  };
  fn.colored = true;
  return fn;
}

/* ── Правка углов ──────────────────────────────────────────────── */

function polyArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

/** Точка внутри четырёхугольника (выпуклого или нет — по чётности). */
export function insideQuad(q, x, y) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Рамка четырёхугольника — по ней трафарет отсекает лишние треугольники. */
export function quadBounds(q, pad = 2) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
}

/**
 * Прямоугольник по протяжке — с пропорциями картинки: ширину задаёт рука,
 * высота следует. Щелчок без протяжки ставит картинку размером size по центру.
 */
export function quadFromDrag(a, b, aspect, size) {
  let x0 = a.x, y0 = a.y, w = b.x - a.x, h;
  if (Math.abs(w) < 4 && Math.abs(b.y - a.y) < 4) {
    w = size; h = size / aspect;
    x0 = a.x - w / 2; y0 = a.y - h / 2;
  } else {
    if (Math.abs(w) < 4) w = Math.abs(b.y - a.y) * aspect * Math.sign(w || 1);
    h = Math.abs(w) / aspect * Math.sign(b.y - a.y || 1);
    if (w < 0) { x0 += w; w = -w; }
    if (h < 0) { y0 += h; h = -h; }
  }
  return [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }];
}

/**
 * Что под указателем у поставленной картинки. Координаты — экранные, в
 * пикселях панели: ручки одного размера при любом масштабе развёртки.
 * @returns {null|{kind:'corner', i}|{kind:'rotate'}|{kind:'move'}}
 */
export function hitQuad(q, x, y) {
  let best = -1, bd = Infinity;
  q.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } });
  if (bd <= 9) return { kind: 'corner', i: best };
  if (insideQuad(q, x, y)) return { kind: 'move' };
  // Чуть дальше за углом — вращение, как в свободном трансформировании.
  if (bd <= 28) return { kind: 'rotate' };
  return null;
}

/**
 * Жест правки: начинается на картинке, ведётся в координатах её пространства
 * (экран модели или тексели развёртки), углы правятся от положения на начало
 * жеста — так Shift можно нажать и отпустить посреди протяжки.
 */
export function dragQuad(kind, start, from, p, shift) {
  const q = start.map((c) => ({ ...c }));
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  if (kind.kind === 'move') {
    const dx = p.x - from.x, dy = p.y - from.y;
    return q.map((c) => ({ x: c.x + dx, y: c.y + dy }));
  }
  if (kind.kind === 'rotate') {
    let ang = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(from.y - cy, from.x - cx);
    // Shift — шагами по 15°, как поворот вида шагами.
    if (shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
    const cs = Math.cos(ang), sn = Math.sin(ang);
    return q.map((c) => ({ x: cx + (c.x - cx) * cs - (c.y - cy) * sn, y: cy + (c.x - cx) * sn + (c.y - cy) * cs }));
  }
  // Угол. Свободно — двигается только он; с Shift — вся картинка
  // растягивается от противоположного угла, пропорции сохраняются.
  const i = kind.i;
  if (!shift) { q[i] = { x: start[i].x + p.x - from.x, y: start[i].y + p.y - from.y }; return q; }
  const o = start[(i + 2) % 4];
  const vx = start[i].x - o.x, vy = start[i].y - o.y;
  const len2 = vx * vx + vy * vy || 1;
  const want = { x: start[i].x + p.x - from.x, y: start[i].y + p.y - from.y };
  const k = Math.max(0.02, ((want.x - o.x) * vx + (want.y - o.y) * vy) / len2);
  return start.map((c) => ({ x: o.x + (c.x - o.x) * k, y: o.y + (c.y - o.y) * k }));
}

/* ── Слой поверх панели ────────────────────────────────────────── */

/**
 * Картинка на своих углах поверх панели — то, что ляжет, ровно там, где
 * ляжет: на модели проекция идёт с экрана, и экранная картинка и есть
 * предпросмотр. Указатель слой не ловит — ввод остаётся за панелью.
 */
export class DecalOverlay {
  constructor(host) {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = 'decal-ov';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.root.append(this.img, this.svg);
    host.appendChild(this.root);
    this._url = null;
  }

  /**
   * @param {{x,y}[]} q углы в пикселях относительно box
   * @param {{left, top, width, height}} box где лежит холст панели внутри host
   */
  /**
   * @param {boolean} [image=true] рисовать саму картинку; над моделью её
   *   рисует видеокарта прямо на поверхности, здесь остаются рамка и ручки
   */
  show(img, q, box, image = true) {
    if (this._url !== img.url) { this.img.src = img.url; this._url = img.url; }
    this.img.hidden = !image;
    Object.assign(this.root.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
    this.img.style.width = img.w + 'px';
    this.img.style.height = img.h + 'px';
    this.img.style.transform = quadMatrix3d(img.w, img.h, q);
    const pts = q.map((p) => `${p.x},${p.y}`).join(' ');
    this.svg.innerHTML = `<polygon points="${pts}"/>` +
      q.map((p) => `<rect x="${p.x - 4.5}" y="${p.y - 4.5}" width="9" height="9"/>`).join('');
    this.root.classList.add('on');
  }

  hide() { this.root.classList.remove('on'); }
}

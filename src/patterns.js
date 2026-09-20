/**
 * Процедурные узоры материала.
 *
 * Считаются формулой по координатам развёртки, а не берутся картинками:
 * узор тогда не зависит от размера текстуры, ничего не грузится с диска и
 * один и тот же тексель всегда даёт одно и то же значение. Последнее важно —
 * за мазок тексель задевается десятки раз, и «случайный» узор мерцал бы.
 *
 * Каждый узор возвращает 0..1: долю подмеса второго цвета материала.
 */

function hash(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Плавный шум: решётка случайных значений с мягкой интерполяцией. */
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

function fbm(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f) * amp; f *= 2; amp *= 0.5; }
  return s;
}

const fract = (v) => v - Math.floor(v);
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/* ── Сами узоры ────────────────────────────────────────────────── */

const FN = {
  none: () => 0,

  // Волокно: кольца, сбитые шумом вдоль одной оси.
  wood: (u, v, s) => {
    const warp = fbm(u * s * 0.8, v * s * 0.12, 3) * 2.2;
    const rings = Math.abs(Math.sin((u * s * 3.2 + warp) * Math.PI));
    return rings * 0.75 + fbm(u * s * 12, v * s * 1.5, 2) * 0.25;
  },

  // Крап камня: крупные пятна поверх мелкой крошки.
  stone: (u, v, s) => fbm(u * s * 3, v * s * 3, 5),

  // Кладка со смещением рядов и швом.
  brick: (u, v, s) => {
    const rows = s * 5;
    const row = Math.floor(v * rows);
    const bu = fract(u * s * 2.5 + (row % 2 ? 0.5 : 0));
    const bv = fract(v * rows);
    const seam = Math.min(smoothstep(0, 0.05, bu) * smoothstep(1, 0.95, bu),
                          smoothstep(0, 0.09, bv) * smoothstep(1, 0.91, bv));
    return 1 - seam * (0.85 + hash(row, Math.floor(u * s * 2.5)) * 0.15);
  },

  // Мелкая крошка по текселям.
  noise: (u, v, s) => hash(Math.floor(u * s * 90), Math.floor(v * s * 90)),

  // Полосы.
  stripes: (u, _v, s) => smoothstep(0.45, 0.55, Math.abs(fract(u * s * 5) - 0.5) * 2),

  // Клетка.
  checker: (u, v, s) => ((Math.floor(u * s * 5) + Math.floor(v * s * 5)) % 2 + 2) % 2,

  // Царапины: редкие вытянутые волокна.
  scratch: (u, v, s) => smoothstep(0.58, 0.64, fbm(u * s * 1.5, v * s * 26, 3)),

  // Трава: вертикальные штрихи разной длины.
  grass: (u, v, s) => {
    const col = Math.floor(u * s * 26);
    const h = 0.25 + hash(col, 7) * 0.7;
    const jitter = hash(col, 13) * 0.25;
    return smoothstep(h + jitter, h + jitter - 0.12, v) * (0.7 + hash(col, 21) * 0.3);
  },

  // Ржавые потёки: шум, вытянутый вниз.
  rust: (u, v, s) => {
    const streak = fbm(u * s * 6, v * s * 0.8, 4);
    return smoothstep(0.42, 0.72, streak + fbm(u * s * 20, v * s * 20, 2) * 0.22);
  },
};

export const PATTERNS = [
  { id: 'none', name: 'Без узора' },
  { id: 'wood', name: 'Волокно' },
  { id: 'stone', name: 'Крап' },
  { id: 'brick', name: 'Кладка' },
  { id: 'noise', name: 'Крошка' },
  { id: 'stripes', name: 'Полосы' },
  { id: 'checker', name: 'Клетка' },
  { id: 'scratch', name: 'Царапины' },
  { id: 'grass', name: 'Трава' },
  { id: 'rust', name: 'Потёки' },
];

export const DEFAULT_PATTERN = { id: 'none', scale: 8, contrast: 1 };

/**
 * Значение узора в точке развёртки.
 * @param {object} p {id, scale, contrast}
 * @returns {number} 0..1 — сколько подмешать второго цвета
 */
export function patternAt(p, u, v) {
  const fn = FN[p?.id] || FN.none;
  const raw = fn(u, v, p.scale ?? 8);
  const c = p.contrast ?? 1;
  return Math.max(0, Math.min(1, (raw - 0.5) * c + 0.5));
}

/** Есть ли вообще узор — чтобы не считать формулу на каждый тексель зря. */
export function hasPattern(p) { return !!p && p.id && p.id !== 'none'; }

/** Нарисовать образец узора в полотно — для списка узоров. */
export function drawPatternSample(canvas, pattern, colorA, colorB) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = patternAt(pattern, x / w, 1 - y / h);
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) d[o + c] = colorA[c] + (colorB[c] - colorA[c]) * k;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

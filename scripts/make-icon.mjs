/**
 * Значок приложения.
 *
 * Рисуется кодом и кладётся в build/icon.png — electron-builder сам сделает
 * из него .icns и .ico. Держим генератор в проекте, а не готовый файл: значок
 * тогда можно поправить одной строкой, и он не «приходит ниоткуда».
 *
 * Картинку пишем вручную: PNG — это zlib-поток строк развёртки плюс четыре
 * блока с контрольными суммами, ради такого тянуть графическую библиотеку
 * в зависимости незачем.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

/* ── Немного геометрии ─────────────────────────────────────────── */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge, width, d) => clamp01((edge - d) / width + 0.5);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Расстояние до скруглённого квадрата: отрицательное внутри. */
function roundedBox(x, y, half, radius) {
  const dx = Math.abs(x) - half + radius;
  const dy = Math.abs(y) - half + radius;
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Квадратичная кривая, по которой идёт мазок. */
function bezier(t) {
  const [x0, y0] = [-0.74, 0.46];
  const [x1, y1] = [-0.02, 0.62];
  const [x2, y2] = [0.76, -0.18];
  const k = 1 - t;
  return [
    k * k * x0 + 2 * k * t * x1 + t * t * x2,
    k * k * y0 + 2 * k * t * y1 + t * t * y2,
  ];
}

/**
 * Расстояние до отрезка и доля пути по нему.
 * Доля нужна, чтобы толщина мазка менялась вдоль кривой непрерывно: если
 * брать её от номера отрезка, край идёт ступеньками.
 */
function segment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return [Math.hypot(wx - vx * t, wy - vy * t), t];
}

/* ── Сам рисунок ───────────────────────────────────────────────── */

function pixel(x, y) {
  // Координаты от −1 до 1, центр в середине значка.
  const u = (x + 0.5) / SIZE * 2 - 1;
  const v = (y + 0.5) / SIZE * 2 - 1;
  const px = 2 / SIZE;             // один пиксель в этих координатах

  // Подложка: тёмный скруглённый квадрат, как фон инструмента.
  const plate = smooth(0, px * 1.5, roundedBox(u, v, 0.94, 0.42));
  let col = [0.106, 0.114, 0.129];
  let alpha = plate;

  // Шар материала — узнаваемый предмет этого инструмента.
  const R = 0.56;
  const d = Math.hypot(u, v + 0.04);
  if (d < R + px) {
    const nz = Math.sqrt(Math.max(0, 1 - (d / R) ** 2));
    const nx = u / R, ny = -(v + 0.04) / R;

    // Свет сверху-слева плюс мягкая подсветка снизу — тот же приём, что и в
    // превью материалов внутри программы.
    const L = [-0.42, 0.6, 0.68];
    const ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    const H = [-0.26, 0.37, 1.06];
    const hl = Math.hypot(...H);
    const ndh = Math.max(0, (nx * H[0] + ny * H[1] + nz * H[2]) / hl);

    const base = [0.878, 0.639, 0.333];          // охра интерфейса
    const shade = mix([0.35, 0.18, 0.11], base, ndl * 0.85 + 0.2);
    const lit = shade.map((c) => c + Math.pow(ndh, 34) * 0.85);

    col = mix(col, lit.map(clamp01), smooth(0, px * 1.5, d - R) * plate);
  }

  // Мазок поверх шара: дуга, сужающаяся к концам — так он читается кистью,
  // а не стрелкой. Кривую считаем отрезками, попутно запоминая, насколько
  // далеко по ней мы находимся: от этого зависит толщина.
  const STEPS = 48;
  let sd = Infinity;
  let prev = bezier(0);
  for (let i = 1; i <= STEPS; i++) {
    const t1 = i / STEPS;
    const cur = bezier(t1);
    const [d, local] = segment(u, v, prev[0], prev[1], cur[0], cur[1]);
    // Толщина: полная в середине, сходит на нет по концам.
    const t = (i - 1 + local) / STEPS;
    const w = 0.13 * Math.sin(Math.PI * t) ** 0.5;
    // Минимум берём уже от «расстояние минус толщина» — так поле расстояний
    // остаётся гладким, и край мазка не рвётся между отрезками.
    if (d - w < sd) sd = d - w;
    prev = cur;
  }
  const stroke = smooth(0, px * 1.5, sd) * plate;
  col = mix(col, [0.784, 0.337, 0.235], stroke * 0.95);   // терракота

  return [...col.map((c) => Math.round(clamp01(c) * 255)), Math.round(alpha * 255)];
}

/* ── Запись PNG ────────────────────────────────────────────────── */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;                    // фильтр строки: без предсказания
  for (let x = 0; x < SIZE; x++) {
    const p = pixel(x, y);
    raw[o++] = p[0]; raw[o++] = p[1]; raw[o++] = p[2]; raw[o++] = p[3];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // бит на канал
ihdr[9] = 6;    // RGBA
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));

console.log(`значок готов: ${OUT} (${SIZE}×${SIZE})`);

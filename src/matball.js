/**
 * Шарик материала — тот самый превью-шар из Blender и 3ds Max.
 *
 * Считается аналитически в обычном 2D-полотне, без второй сцены three.js:
 * сфера — единственная форма, у которой нормаль в точке известна из самой
 * точки, так что освещение берётся формулой. Для полусотни образцов это
 * дешевле, чем полсотни рендеров, и перерисовывается мгновенно при каждом
 * движении ползунка шероховатости.
 */

import { patternAt, hasPattern } from './patterns.js';

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// Ключевой свет сверху-слева и слабая подсветка снизу-справа: без второй
// лампы тёмная сторона шара сливается с фоном и форма не читается.
const KEY = norm([-0.45, 0.62, 0.64]);
const FILL = norm([0.62, -0.3, 0.55]);
const HALF_KEY = norm([KEY[0], KEY[1], KEY[2] + 1]);
const HALF_FILL = norm([FILL[0], FILL[1], FILL[2] + 1]);

/** Шахматка под шаром: без неё прозрачность материала ничем себя не выдаёт. */
function drawChecker(ctx, w, h) {
  const step = Math.max(6, Math.round(w / 12));
  ctx.fillStyle = '#2a2d32';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#34383e';
  for (let y = 0; y < h; y += step) {
    for (let x = ((y / step) | 0) % 2 ? step : 0; x < w; x += step * 2) {
      ctx.fillRect(x, y, step, step);
    }
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} m {color:[r,g,b], roughness, metalness, alpha, checker}
 */
export function drawMaterialBall(canvas, m) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (m.checker) drawChecker(ctx, w, h);

  const R = Math.min(w, h) * 0.44;
  const cx = w / 2, cy = h / 2 - h * 0.02;

  // Тень на подложке — без неё шар висит в пустоте.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy + R * 0.98, R * 0.85, R * 0.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(0,0,0,${0.38 * (m.alpha ?? 1)})`;
  ctx.filter = 'blur(2px)';
  ctx.fill();
  ctx.restore();

  const rough = Math.max(0.03, Math.min(1, m.roughness ?? 0.9));
  const metal = Math.max(0, Math.min(1, m.metalness ?? 0));

  // Шероховатость в показатель Блинна: гладкому материалу — узкий блик.
  const a = rough * rough;
  const shin = Math.max(1, 2 / (a * a) - 2);
  const specGain = 0.35 + 0.65 * (1 - rough);
  // Металл виден только отражением, поэтому среды ему нужно больше.
  const envGain = (0.18 + 0.5 * (1 - rough)) * (0.35 + 0.65 * metal) + 0.12 * metal;

  // Считаем в линейном пространстве, наружу отдаём через корень: иначе
  // полутона уходят в грязь.
  const toLin = (c) => c.map((v) => (v / 255) ** 2);
  const baseA = toLin(m.color || [180, 180, 180]);
  const baseB = toLin(m.color2 || m.color || [180, 180, 180]);
  const tex = (m.pattern?.id === 'image' && m.texture) ? m.texture : null;
  const pat = (!tex && hasPattern(m.pattern) && m.pattern.id !== 'image') ? m.pattern : null;
  const tiles = Math.max(0.05, (m.pattern?.scale ?? 8) / 4);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  for (let y = 0; y < h; y++) {
    const ny = -(y + 0.5 - cy) / R;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5 - cx) / R;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1.02) continue;

      const nz = Math.sqrt(Math.max(0, 1 - r2));
      const o = (y * w + x) * 4;

      const light = (L, H, k) => {
        const ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        const ndh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]);
        return { ndl: ndl * k, spec: Math.pow(ndh, shin) * ndl * k * specGain };
      };
      const k1 = light(KEY, HALF_KEY, 1);
      const k2 = light(FILL, HALF_FILL, 0.35);

      // Отражение среды. Без него металл выходит чёрным: диффузной
      // составляющей у него нет, а точечный блик — это одна яркая точка.
      // Считаем вектор отражения и берём простую студию: небо сверху,
      // светлая полоса у горизонта, тёмный пол снизу.
      const ry = 2 * nz * ny;
      let env = 0.1 + 0.62 * (ry * 0.5 + 0.5);
      env += 0.5 * Math.exp(-((ry / 0.22) ** 2));
      // Шероховатость размывает отражение: контраст уходит к среднему.
      env += (0.42 - env) * (rough * 0.85);

      // Узор и картинку наносим по сферической развёртке — как они легли бы
      // на шар.
      let base = baseA;
      if (pat || tex) {
        const u = 0.5 + Math.atan2(nx, nz) / (2 * Math.PI);
        const vv = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / Math.PI;
        if (tex) {
          const tu = u * tiles, tv = (1 - vv) * tiles;
          const ix = Math.min(tex.w - 1, ((tu - Math.floor(tu)) * tex.w) | 0);
          const iy = Math.min(tex.h - 1, ((1 - (tv - Math.floor(tv))) * tex.h) | 0);
          const io = (iy * tex.w + ix) * 4;
          base = [0, 1, 2].map((c) => (tex.data[io + c] / 255) ** 2);
        } else {
          const k = patternAt(pat, u, 1 - vv);
          base = [0, 1, 2].map((c) => baseA[c] + (baseB[c] - baseA[c]) * k);
        }
      }
      const diff = base.map((v) => v * (1 - metal));
      // У металла блик красится самим материалом, у диэлектрика он белый.
      const f0 = base.map((v) => 0.04 * (1 - metal) + v * metal);

      const amb = 0.14 + 0.1 * Math.max(0, ny);
      const rim = Math.pow(1 - nz, 4) * 0.35 * (1 - rough * 0.6);
      const dl = k1.ndl + k2.ndl + amb;
      const sp = k1.spec + k2.spec + rim + env * envGain;

      // Сглаживаем край: без этого силуэт шара идёт ступеньками.
      // Альфа материала гасит шар — сквозь него проступает шахматка.
      const cover = Math.max(0, Math.min(1, (1 - Math.sqrt(r2)) * R * 1.6 + 0.5)) * (m.alpha ?? 1);
      if (cover <= 0) continue;

      // Кладём шар поверх тени, а не вместо неё: иначе тень у самого края
      // перекрашивается в цвет материала.
      const dstA = d[o + 3] / 255;
      const outA = cover + dstA * (1 - cover);
      for (let c = 0; c < 3; c++) {
        const lin = diff[c] * dl + f0[c] * sp;
        const src = Math.min(255, Math.sqrt(Math.max(0, lin)) * 255);
        d[o + c] = (src * cover + d[o + c] * dstA * (1 - cover)) / outA;
      }
      d[o + 3] = outA * 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

/**
 * Демо-модель — низкополигональная хижина в реальном масштабе (1 unit = 1 м),
 * как принято в проекте. Нужна, чтобы инструмент можно было открыть и сразу
 * красить, не имея под рукой GLB.
 *
 * Собирается вручную, а не из примитивов three.js, ровно по одной причине:
 * у BoxGeometry все шесть граней занимают в развёртке один и тот же квадрат
 * 0..1. На такой модели мазок по передней стене проступает на всех остальных,
 * а кисть вместо круга оставляет обрезки — тексель принадлежит шести граням
 * сразу. Здесь у каждой грани своя клетка атласа.
 */


import * as THREE from 'three';

const GRID = 6;          // атлас 6×6 клеток: по клетке на каждую грань
const MARGIN = 0.012;    // поле клетки: не даёт растеканию залезть к соседу

/** Прямоугольник клетки атласа по её номеру: [u0, v0, u1, v1]. */
function cell(i) {
  const cx = i % GRID, cy = (i / GRID) | 0;
  const s = 1 / GRID;
  return [cx * s + MARGIN, cy * s + MARGIN, (cx + 1) * s - MARGIN, (cy + 1) * s - MARGIN];
}

class Builder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; }

  /** Треугольник с явными UV; нормаль считается из обхода вершин. */
  tri(p0, p1, p2, t0, t1, t2) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    this.pos.push(...p0, ...p1, ...p2);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.uv.push(...t0, ...t1, ...t2);
  }

  /** Четырёхугольник, развёрнутый на всю клетку атласа. */
  quad(a, b, c, d, cellRect) {
    const [u0, v0, u1, v1] = cellRect;
    this.tri(a, b, c, [u0, v0], [u1, v0], [u1, v1]);
    this.tri(a, c, d, [u0, v0], [u1, v1], [u0, v1]);
  }

  /** Коробка с отдельной клеткой на каждую грань. */
  box(cx, cy, cz, w, h, d, cells) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const P = (x, y, z) => [x, y, z];

    this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), cell(cells[0])); // перёд
    this.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), cell(cells[1])); // зад
    this.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), cell(cells[2])); // право
    this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), cell(cells[3])); // лево
    this.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), cell(cells[4])); // верх
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), cell(cells[5])); // низ
  }

  /** Четырёхскатная крыша: четыре ската, каждый в своей клетке. */
  roof(cx, cy, cz, w, d, h, cells) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const apex = [cx, cy + h, cz];
    const slopes = [
      [[x0, cy, z1], [x1, cy, z1]],
      [[x1, cy, z1], [x1, cy, z0]],
      [[x1, cy, z0], [x0, cy, z0]],
      [[x0, cy, z0], [x0, cy, z1]],
    ];
    slopes.forEach(([a, b], i) => {
      const [u0, v0, u1, v1] = cell(cells[i]);
      this.tri(a, b, apex, [u0, v0], [u1, v0], [(u0 + u1) / 2, v1]);
    });
    // Подшивка снизу — чтобы крыша не просвечивала с изнанки.
    this.quad([x0, cy, z0], [x1, cy, z0], [x1, cy, z1], [x0, cy, z1], cell(cells[4]));
  }

  build(name) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.name = name;
    return geo;
  }
}

export function buildDemoMesh() {
  const b = new Builder();

  // Корпус 3.0 × 2.4 × 3.6 м — стены в человеческий рост.
  b.box(0, 1.2, 0, 3.0, 2.4, 3.6, [0, 1, 2, 3, 4, 5]);

  // Крыша со свесом, конёк на 1.5 м выше стен.
  b.roof(0, 2.4, 0, 3.8, 4.4, 1.5, [6, 7, 8, 9, 10]);

  // Труба.
  b.box(0.85, 3.1, 0.6, 0.4, 1.4, 0.4, [11, 12, 13, 14, 15, 16]);

  // Ступень у входа — 0.17 м, стандартная высота подъёма.
  b.box(0, 0.085, 2.15, 1.4, 0.17, 0.7, [17, 18, 19, 20, 21, 22]);

  // Дверь — полотно перед стеной. Отступ 3 см, не миллиметр: на миллиметре
  // глубина не различает полотно и стену, и дверь идёт полосами (z-fighting).
  const dz = 1.83;
  const [u0, v0, u1, v1] = cell(23);
  b.tri([-0.45, 0.0, dz], [0.45, 0.0, dz], [0.45, 2.0, dz], [u0, v0], [u1, v0], [u1, v1]);
  b.tri([-0.45, 0.0, dz], [0.45, 2.0, dz], [-0.45, 2.0, dz], [u0, v0], [u1, v1], [u0, v1]);

  // Откосы проёма — каждый в своей клетке и лицом внутрь проёма, иначе
  // инструмент справедливо ругается на наложение развёртки.
  b.quad([-0.45, 0.0, 1.8], [-0.45, 2.0, 1.8], [-0.45, 2.0, dz], [-0.45, 0.0, dz], cell(24));
  b.quad([0.45, 0.0, dz], [0.45, 2.0, dz], [0.45, 2.0, 1.8], [0.45, 0.0, 1.8], cell(25));
  b.quad([-0.45, 2.0, 1.8], [0.45, 2.0, 1.8], [0.45, 2.0, dz], [-0.45, 2.0, dz], cell(26));

  const mesh = new THREE.Mesh(b.build('Cabin'), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  mesh.name = 'Cabin';   // имя объекта техническое, его не переводят
  return mesh;
}

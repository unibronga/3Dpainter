/**
 * Инструменты для ИИ — то, что оболочка отдаёт наружу по MCP.
 *
 * Здесь смысл, а транспорт — в `electron/mcp.cjs`: оболочка принимает
 * запросы на localhost и зовёт `window.__mcp.call(имя, аргументы)`. Странице
 * Node для этого не нужен, а в браузере эти функции просто никто не зовёт.
 *
 * Модель ИИ плохо видит, куда кладёт мазок, зато хорошо рассуждает словами.
 * Поэтому первая версия — не кисть по координатам, а описание модели
 * словами и заливка по признакам:
 *   - области — связные куски поверхности без излома круче 30° (грань
 *     крыши, стена, торец двери): то, что человек назвал бы «частью»;
 *   - острова развёртки — как у заливки острова (G);
 *   - материалы из файла — у моделей из Blender они часто уже названы
 *     («Roof», «Wood»);
 *   - куда смотрит поверхность и на какой она высоте.
 * Заливка идёт тем же путём, что у человека: `Stroke.fillTriangles`, шаг в
 * истории, отмена ⌘Z. Снимок вида — чтобы ИИ проверил, что получилось.
 *
 * Описания инструментов — по-английски: их читает модель, а не человек.
 */

import * as THREE from 'three';
import { floodFaces } from './mesh-cache.js';

/** Излом, на котором кончается «область»: круче — это уже другая часть. */
const REGION_ANGLE = 30;
/** Больше областей в описании не перечисляем: у гладкой сферы их тысячи. */
const MAX_LISTED = 120;

const FACING = [
  ['up', [0, 1, 0]], ['down', [0, -1, 0]],
  ['front', [0, 0, 1]], ['back', [0, 0, -1]],
  ['right', [1, 0, 0]], ['left', [-1, 0, 0]],
];

const VIEWS = ['current', 'front', 'back', 'left', 'right', 'top', 'bottom', 'three-quarter'];

export const TOOLS = [
  {
    name: 'describe_model',
    description:
      'Describe the open 3D model in words so you can decide what to paint. Returns meshes, ' +
      'their parts and layers. A "region" is a connected patch of surface without a fold ' +
      'sharper than 30 degrees (a roof plane, a wall, a door face). An "island" is a UV ' +
      'island. Each part has an id, triangle count, share of the mesh surface, world-space ' +
      'center and average normal, the direction it faces (up/down/front/back/left/right), ' +
      'the source material name when the file had one, and its current average color. ' +
      'World axes: Y is up, +Z is the front of the model as it stands, +X is its right; ' +
      'units are meters. Ids are stable until another model is opened.',
    inputSchema: {
      type: 'object',
      properties: {
        mesh: { description: 'Only this mesh: index or name. Omit for all meshes.', type: ['integer', 'string'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'render_view',
    description:
      'Render the model as it looks now (paint, lighting and any view effect) and return a PNG, ' +
      'so you can check your work. The user\'s own camera is left where it was.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: VIEWS, description: 'Camera direction. "current" is what the user sees. Default "three-quarter".' },
        width: { type: 'integer', minimum: 64, maximum: 2048, description: 'Default 768.' },
        height: { type: 'integer', minimum: 64, maximum: 2048, description: 'Default 576.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description:
      'Fill part of the model with a color and surface, like the paint bucket. The target ' +
      'selects triangles; every given criterion must match (AND). Criteria: mesh, regions, ' +
      'islands, material (source material name), facing, and a height range on the world ' +
      'Y of each triangle center. With no criteria but a mesh, the whole mesh is filled. ' +
      'Paint goes into the active layer (or the given one) and is one undo step per mesh.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            mesh: { type: ['integer', 'string'], description: 'Mesh index or name.' },
            regions: { type: 'array', items: { type: 'integer' }, description: 'Region ids from describe_model.' },
            islands: { type: 'array', items: { type: 'integer' }, description: 'UV island ids from describe_model.' },
            material: { type: 'string', description: 'Source material name (exact, case-insensitive).' },
            facing: { type: 'string', enum: FACING.map(([n]) => n), description: 'Triangles whose normal is within 45 degrees of this direction.' },
            above: { type: 'number', description: 'Triangle center Y (meters) must be at least this.' },
            below: { type: 'number', description: 'Triangle center Y (meters) must be at most this.' },
          },
          additionalProperties: false,
        },
        color: { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$', description: 'Color as #RRGGBB.' },
        roughness: { type: 'number', minimum: 0, maximum: 1, description: '0 glossy .. 1 matte. Default 0.9.' },
        metalness: { type: 'number', minimum: 0, maximum: 1, description: '0 dielectric .. 1 metal. Default 0.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Material opacity: below 1 is glass. Default 1.' },
        layer: { type: 'integer', minimum: 0, description: 'Layer index; default is the active layer.' },
      },
      required: ['target', 'color'],
      additionalProperties: false,
    },
  },
  {
    name: 'new_layer',
    description: 'Add a paint layer above the active one and make it active. Painting on your own layer lets the user hide or delete your work in one click.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', maxLength: 60 } },
      additionalProperties: false,
    },
  },
  {
    name: 'save_project',
    description: 'Save the whole session (model, all layers, settings) as a native .3dpaint project file at an absolute path on the user\'s computer.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path ending in .3dpaint.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

/* ── Разбор модели на части ────────────────────────────────────── */

/**
 * Части меша: области и острова. Считается один раз на меш и кэшируется в
 * `userData` — номера частей должны совпадать между описанием и заливкой.
 * Номер — по первому треугольнику части, обход по порядку: так один и тот
 * же меш даёт одни и те же номера.
 */
function partsOf(mesh, cache) {
  if (mesh.userData.mcpParts) return mesh.userData.mcpParts;
  const n = cache.triCount;
  const split = (mode, angle) => {
    const id = new Int32Array(n).fill(-1);
    const list = [];
    for (let t = 0; t < n; t++) {
      if (id[t] >= 0) continue;
      const set = floodFaces(cache, t, angle, mode);
      for (const x of set) id[x] = list.length;
      list.push([...set]);
    }
    return { id, list };
  };
  const parts = { regions: split('geom', REGION_ANGLE), islands: split('uv', 180) };
  // Кэш геометрии отдаётся в файл — прячем части так же, как paintCache:
  // `formats.js` снимает userData на время выгрузки целиком.
  mesh.userData.mcpParts = parts;
  return parts;
}

/** Мировые центр, нормаль и площадь каждого треугольника. */
function triGeometry(mesh, cache) {
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const { pos, idx, triCount } = cache;
  const center = new Float32Array(triCount * 3);
  const normal = new Float32Array(triCount * 3);
  const area = new Float32Array(triCount);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    a.fromArray(pos, idx[t * 3] * 3).applyMatrix4(m);
    b.fromArray(pos, idx[t * 3 + 1] * 3).applyMatrix4(m);
    c.fromArray(pos, idx[t * 3 + 2] * 3).applyMatrix4(m);
    center[t * 3] = (a.x + b.x + c.x) / 3;
    center[t * 3 + 1] = (a.y + b.y + c.y) / 3;
    center[t * 3 + 2] = (a.z + b.z + c.z) / 3;
    e1.subVectors(b, a); e2.subVectors(c, a);
    const cr = e1.cross(e2);
    area[t] = cr.length() / 2;
    // Нормаль — из кэша (в пространстве меша), в мир — нормальной матрицей:
    // так она верна и у отзеркаленных объектов.
    const fn = new THREE.Vector3().fromArray(cache.faceNormal, t * 3).applyMatrix3(nm).normalize();
    normal[t * 3] = fn.x; normal[t * 3 + 1] = fn.y; normal[t * 3 + 2] = fn.z;
  }
  return { center, normal, area };
}

function facingOf(nx, ny, nz) {
  let best = FACING[0][0], dot = -2;
  for (const [name, [x, y, z]] of FACING) {
    const d = nx * x + ny * y + nz * z;
    if (d > dot) { dot = d; best = name; }
  }
  return best;
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Имя материала из файла у треугольника: группы геометрии с именами. */
function materialNames(mesh, triCount) {
  const names = new Array(triCount).fill(null);
  for (const g of mesh.userData.sourceGroups || []) {
    if (!g.name) continue;
    for (let t = g.from; t < g.to; t++) names[t] = g.name;
  }
  return names;
}

/**
 * Средний цвет набора треугольников — по текселям их центров в итоговой
 * карте. Центр треугольника в развёртке надёжнее угла: угол лежит на шве.
 */
function averageColor(target, cache, tris) {
  const S = target.size;
  const px = target.composite;          // RGBA итоговой карты, строки сверху вниз
  if (!px) return null;
  const { uv, idx } = cache;
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(tris.length / 400));
  for (let i = 0; i < tris.length; i += step) {
    const t = tris[i];
    const u = (uv[idx[t * 3] * 2] + uv[idx[t * 3 + 1] * 2] + uv[idx[t * 3 + 2] * 2]) / 3;
    const v = (uv[idx[t * 3] * 2 + 1] + uv[idx[t * 3 + 1] * 2 + 1] + uv[idx[t * 3 + 2] * 2 + 1]) / 3;
    const x = Math.min(S - 1, Math.max(0, Math.floor(u * S)));
    const y = Math.min(S - 1, Math.max(0, Math.floor((1 - v) * S)));
    const o = (y * S + x) * 4;
    r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
  }
  return n ? hex(r / n, g / n, b / n) : null;
}

/* ── Инструменты ───────────────────────────────────────────────── */

/**
 * @param {object} api что страница даёт инструментам:
 *   viewport, targets (Map меш → PaintTarget), history, layers(): имена,
 *   activeLayer(), addLayer(name), fillTriangles(mesh, set, opts, layer),
 *   projectBytes(): Promise<Uint8Array>, modelName(), notify(text)
 */
export function createMcpTools(api) {
  const { viewport } = api;

  function requireModel() {
    if (!viewport.model || !viewport.paintables.length) {
      throw new Error('No model is open in 3DPainter. Ask the user to open one (or the demo cabin).');
    }
  }

  function meshesFor(sel) {
    const all = viewport.paintables.map((p, i) => ({ ...p, index: i }));
    if (sel === undefined || sel === null) return all;
    const found = typeof sel === 'number'
      ? all.filter((p) => p.index === sel)
      : all.filter((p) => p.mesh.name.toLowerCase() === String(sel).toLowerCase());
    if (!found.length) throw new Error(`No mesh ${JSON.stringify(sel)}. Meshes: ${all.map((p) => `${p.index} "${p.mesh.name}"`).join(', ')}.`);
    return found;
  }

  function describePart(list, i, geo, total, names, target, cache) {
    const tris = list[i];
    let area = 0, cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    for (const t of tris) {
      const a = geo.area[t];
      area += a;
      cx += geo.center[t * 3] * a; cy += geo.center[t * 3 + 1] * a; cz += geo.center[t * 3 + 2] * a;
      nx += geo.normal[t * 3] * a; ny += geo.normal[t * 3 + 1] * a; nz += geo.normal[t * 3 + 2] * a;
    }
    const k = area || 1;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const mats = new Set(tris.map((t) => names[t]).filter(Boolean));
    const out = {
      id: i,
      triangles: tris.length,
      share: Math.round((area / (total || 1)) * 1000) / 10,
      center: [r3(cx / k), r3(cy / k), r3(cz / k)],
      normal: [r3(nx / nl), r3(ny / nl), r3(nz / nl)],
      facing: facingOf(nx / nl, ny / nl, nz / nl),
      color: averageColor(target, cache, tris),
    };
    if (mats.size === 1) out.material = [...mats][0];
    else if (mats.size > 1) out.materials = [...mats];
    // Почти плоская поверхность в разные стороны (сфера, цилиндр) — нормаль
    // средняя ничего не говорит, отметим это словами.
    if (nl / k < 0.5) out.curved = true;
    return out;
  }

  function listParts(list, geo, total, names, target, cache) {
    const order = list.map((_, i) => i);
    const areaOf = (i) => list[i].reduce((s, t) => s + geo.area[t], 0);
    const areas = order.map(areaOf);
    order.sort((a, b) => areas[b] - areas[a]);
    const shown = order.slice(0, MAX_LISTED).sort((a, b) => a - b);
    return {
      count: list.length,
      ...(list.length > MAX_LISTED ? { note: `Only the ${MAX_LISTED} largest are listed.` } : {}),
      items: shown.map((i) => describePart(list, i, geo, total, names, target, cache)),
    };
  }

  function describe_model({ mesh } = {}) {
    requireModel();
    const meshes = meshesFor(mesh).map(({ mesh: m, cache, index }) => {
      const target = api.targets.get(m);
      const parts = partsOf(m, cache);
      const geo = triGeometry(m, cache);
      const total = geo.area.reduce((s, a) => s + a, 0);
      const names = materialNames(m, cache.triCount);
      const box = new THREE.Box3().setFromObject(m);
      const matCount = {};
      for (const n of names) if (n) matCount[n] = (matCount[n] || 0) + 1;
      return {
        index,
        name: m.name,
        triangles: cache.triCount,
        bounds: { min: box.min.toArray().map(r3), max: box.max.toArray().map(r3) },
        materials: Object.entries(matCount).map(([name, triangles]) => ({ name, triangles })),
        regions: listParts(parts.regions.list, geo, total, names, target, cache),
        // Остров на каждый треугольник — развёртка без общих рёбер (у демо
        // так): список был бы шумом, по смыслу части дают области.
        islands: parts.islands.list.length >= cache.triCount * 0.8
          ? { count: parts.islands.list.length, note: 'Every triangle is its own UV island here; use regions instead.' }
          : listParts(parts.islands.list, geo, total, names, target, cache),
      };
    });
    return {
      model: api.modelName(),
      axes: 'Y up, +Z front, +X right, meters',
      layers: api.layers(),
      activeLayer: api.activeLayer(),
      meshes,
    };
  }

  function select(target = {}) {
    const meshes = meshesFor(target.mesh);
    const out = [];
    const dir = target.facing ? FACING.find(([n]) => n === target.facing)?.[1] : null;
    if (target.facing && !dir) throw new Error(`Unknown facing "${target.facing}".`);
    const wantMat = target.material ? String(target.material).toLowerCase() : null;
    for (const { mesh, cache } of meshes) {
      const parts = partsOf(mesh, cache);
      const geo = triGeometry(mesh, cache);
      const names = wantMat ? materialNames(mesh, cache.triCount) : null;
      const regions = target.regions ? new Set(target.regions) : null;
      const islands = target.islands ? new Set(target.islands) : null;
      const set = new Set();
      for (let t = 0; t < cache.triCount; t++) {
        if (regions && !regions.has(parts.regions.id[t])) continue;
        if (islands && !islands.has(parts.islands.id[t])) continue;
        if (wantMat && (names[t] || '').toLowerCase() !== wantMat) continue;
        if (dir) {
          const d = geo.normal[t * 3] * dir[0] + geo.normal[t * 3 + 1] * dir[1] + geo.normal[t * 3 + 2] * dir[2];
          if (d < Math.SQRT1_2) continue;
        }
        const y = geo.center[t * 3 + 1];
        if (typeof target.above === 'number' && y < target.above) continue;
        if (typeof target.below === 'number' && y > target.below) continue;
        set.add(t);
      }
      if (set.size) out.push({ mesh, set });
    }
    return out;
  }

  function fill({ target, color, roughness = 0.9, metalness = 0, opacity = 1, layer }) {
    requireModel();
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!m) throw new Error('color must be #RRGGBB.');
    const n = parseInt(m[1], 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const layers = api.layers();
    if (layer !== undefined && (layer < 0 || layer >= layers.length)) {
      throw new Error(`No layer ${layer}. Layers: ${layers.map((l) => `${l.index} "${l.name}"`).join(', ')}.`);
    }
    const hits = select(target);
    if (!hits.length) throw new Error('The target matched no triangles. Check the ids with describe_model.');
    let total = 0;
    for (const { mesh, set } of hits) {
      api.fillTriangles(mesh, set, {
        color: rgb,
        roughness: Math.min(1, Math.max(0, roughness)),
        metalness: Math.min(1, Math.max(0, metalness)),
        alpha: Math.min(1, Math.max(0, opacity)),
      }, layer);
      total += set.size;
    }
    api.notify('fill', total);
    return {
      filled: hits.map(({ mesh, set }) => ({ mesh: mesh.name, triangles: set.size })),
      layer: layer ?? api.activeLayer(),
      hint: 'Call render_view to check the result.',
    };
  }

  function new_layer({ name } = {}) {
    requireModel();
    const index = api.addLayer(name ? String(name).slice(0, 60) : null);
    return { layer: index, layers: api.layers() };
  }

  async function render_view({ view = 'three-quarter', width = 768, height = 576 } = {}) {
    requireModel();
    if (!VIEWS.includes(view)) throw new Error(`view must be one of ${VIEWS.join(', ')}.`);
    const W = Math.min(2048, Math.max(64, width | 0));
    const H = Math.min(2048, Math.max(64, height | 0));
    // Вид человека не трогаем: ставим свой ракурс на время снимка и
    // возвращаем прежний тем же кадром — на экране он не мелькнёт.
    const было = viewport.viewState();
    let img;
    try {
      if (view !== 'current') {
        viewport.setView(view === 'three-quarter' ? 'user' : view);
        viewport.centerCamera?.();
      }
      img = viewport.renderView(W, H, 2);
    } finally {
      viewport.setViewState(было);
    }
    // Снимок прозрачный; ИИ смотрит на него на неизвестном фоне. Кладём на
    // нейтральный серый — цвета читаются как есть.
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#7a7f87';
    g.fillRect(0, 0, W, H);
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0);
    const data = c.toDataURL('image/png').split(',')[1];
    return { image: data, mimeType: 'image/png', view, width: W, height: H };
  }

  const handlers = { describe_model, render_view, fill, new_layer };

  return {
    list: () => TOOLS,
    /**
     * Вызов инструмента. Ответ — готовое содержимое MCP: текст JSON или
     * картинка. Ошибка — тоже ответ (isError), а не исключение: ИИ должен
     * прочитать, что не так, и поправиться.
     */
    async call(name, args) {
      try {
        if (name === 'save_project') {
          requireModel();
          const bytes = await api.projectBytes();
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { __file: { base64: btoa(s), path: args?.path } };
        }
        const h = handlers[name];
        if (!h) throw new Error(`Unknown tool ${name}.`);
        const res = await h(args || {});
        if (res && res.image) {
          return { content: [
            { type: 'image', data: res.image, mimeType: res.mimeType },
            { type: 'text', text: JSON.stringify({ view: res.view, width: res.width, height: res.height }) },
          ] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 1) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err?.message || err) }], isError: true };
      }
    },
  };
}

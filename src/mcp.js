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
 * Вторая волна — по живому прогону на персонаже (6953 треугольника, один
 * меш, без имён материалов, 1254 области). Высоты и стороны не хватило:
 * кисти рук висят на высоте джинсов, пряжки и глаз нет среди крупных
 * областей, а промах ИИ «откатывал» перекраской и оставлял мусор. Отсюда:
 *   - рамка `box` по X/Y/Z в отборе;
 *   - `fill_at` — заливка по точке на снимке: ИИ видит деталь на картинке,
 *     указывает пиксель, программа сама находит под ним поверхность. Камера
 *     та же, что у `render_view` с теми же видом и размером;
 *   - описание с отбором (рамка, сторона, размер) и постранично;
 *   - `undo` — только своих шагов, чужую работу ИИ не откатывает.
 *
 * Третья волна — владелец показал, что осталось: мелкие треугольники у
 * воротника, у края джинсов над ботинками, у брови. На сплошном снимке ИИ их
 * не видит. Поэтому:
 *   - `find_patches` — программа сама делит поверхность на куски одного
 *     цвета и называет маленькие: где, какого цвета, что вокруг;
 *   - `render_view` рисует каркас (рёбра и вершины), номера пятен и умеет
 *     «плоско», без света, — сверять цвет с референсом;
 *   - `render_uv` — вся развёртка картинкой: покраска, рёбра, пятна;
 *   - заливка по номерам пятен — исправлять точно.
 *
 * Четвёртая волна — владелец показал крупные промахи: низ джинсов в цвет
 * ботинок, клин кожи на рукавах, испорченный камень, а зачистка стёрла дыры
 * на джинсах и край рубашки. Причина: модель собрана из отдельных деталей
 * (31 у персонажа — джинсы, ботинки, напульсники, шлёвки, оправа и центр
 * камня), а ИИ о них не знал и резал её по высоте. Отсюда:
 *   - детали (связные куски геометрии) в описании и заливка по ним —
 *     ровно по границе детали;
 *   - память о том, чем закрашен каждый треугольник: прицельно (деталь,
 *     точка, номер), широко (высота, рамка) или не крашен. Пятно от
 *     прицельной заливки — задуманная деталь, зачистка его не трогает.
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
      'Most important are "pieces": separate connected parts of the geometry (a boot, a ' +
      'wristband, a belt loop, the rim and the center of a gem). Paint by pieces first — ' +
      'fill {target:{pieces:[...]}} follows the part\'s own border exactly, while height ' +
      'bands cut through parts (e.g. jeans that reach inside a boot). ' +
      'World axes: Y is up, +Z is the front of the model as it stands, +X is its right; ' +
      'units are meters. Each part also has a size [dx, dy, dz]. Ids are stable until ' +
      'another model is opened. Big models have hundreds of parts: filter with box, ' +
      'facing and min_triangles, page with offset — or skip ids entirely and use fill_at.',
    inputSchema: {
      type: 'object',
      properties: {
        mesh: { description: 'Only this mesh: index or name. Omit for all meshes.', type: ['integer', 'string'] },
        box: {
          type: 'object',
          description: 'Axis-aligned box in world meters. min/max are [x, y, z]; use null for an open side, e.g. {"min":[0.2,null,null]} is everything right of x=0.2.',
          properties: {
            min: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
            max: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
          },
          additionalProperties: false,
        },
        facing: { type: 'string', enum: ['up', 'down', 'front', 'back', 'right', 'left'], description: 'Only parts facing this way.' },
        min_triangles: { type: 'integer', minimum: 1, description: 'Skip parts smaller than this.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many parts to list per mesh, largest first. Default 120.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many of the largest matching parts (paging).' },
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
        grid: { type: 'boolean', description: 'Draw a labelled pixel grid every 10% to help pick points for fill_at.' },
        wire: { type: 'boolean', description: 'Draw the mesh wireframe (every triangle edge and vertex) so small polygons are visible.' },
        flat: { type: 'boolean', description: 'Unlit colors, exactly as painted — compare colors with a reference this way.' },
        patches: { type: 'boolean', description: 'Mark the patches from the last find_patches with numbered magenta rings (visible ones only).' },
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
            pieces: { type: 'array', items: { type: 'integer' }, description: 'Piece ids from describe_model — whole separate parts. The best way to paint a part.' },
            patches: { type: 'array', items: { type: 'integer' }, description: 'Patch ids from the last find_patches.' },
            box: {
              type: 'object',
              description: 'Axis-aligned box in world meters. min/max are [x, y, z]; use null for an open side, e.g. {"min":[0.2,null,null]} is everything right of x=0.2.',
              properties: {
                min: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
                max: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
              },
              additionalProperties: false,
            },
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
    name: 'fill_at',
    description:
      'Fill whatever is under given pixels of a render_view image. Pass the same view, width ' +
      'and height as the render you looked at, and pixel points (x right, y down from the ' +
      'top-left corner). Under each point the surface patch is found and filled: a patch ' +
      'grows from the hit triangle across folds up to `angle` degrees (0 = just that flat ' +
      'face, 30 = default, like a region; 180 = the whole connected piece). An optional box ' +
      'clips the fill. Use dry_run to see what would be hit without painting. Points that ' +
      'hit nothing are reported.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: VIEWS, description: 'Same as in render_view. Default "three-quarter".' },
        width: { type: 'integer', minimum: 64, maximum: 2048, description: 'Same as in render_view. Default 768.' },
        height: { type: 'integer', minimum: 64, maximum: 2048, description: 'Same as in render_view. Default 576.' },
        points: {
          type: 'array', minItems: 1, maxItems: 64,
          items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
        },
        angle: { type: 'number', minimum: 0, maximum: 180, description: 'How far the patch spreads across folds. Default 30.' },
        box: {
          type: 'object',
          description: 'Axis-aligned box in world meters. min/max are [x, y, z]; use null for an open side, e.g. {"min":[0.2,null,null]} is everything right of x=0.2.',
          properties: {
            min: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
            max: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
          },
          additionalProperties: false,
        },
        color: { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$' },
        roughness: { type: 'number', minimum: 0, maximum: 1 },
        metalness: { type: 'number', minimum: 0, maximum: 1 },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        layer: { type: 'integer', minimum: 0 },
        dry_run: { type: 'boolean', description: 'Only report what the points hit.' },
      },
      required: ['points'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_patches',
    description:
      'Find small leftover patches: the surface is split into connected pieces of one color ' +
      '(across UV seams), and pieces up to max_triangles are reported with where they are, ' +
      'their color, the dominant color around them and how much of their border it covers. ' +
      'Typical finds: a few triangles at a collar or a boot top left in the old color, a ' +
      'missed tip of an eyebrow. Legit small details (eyes, a buckle) show up too — decide ' +
      'with the reference. Then look at them with render_view {patches:true, wire:true} or ' +
      'render_uv, and fix with fill {target:{patches:[...]}}. Ids live until the next call.',
    inputSchema: {
      type: 'object',
      properties: {
        mesh: { type: ['integer', 'string'] },
        max_triangles: { type: 'integer', minimum: 1, maximum: 200, description: 'Largest piece to report. Default 12.' },
        box: {
          type: 'object',
          properties: {
            min: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
            max: { type: 'array', items: { type: ['number', 'null'] }, minItems: 3, maxItems: 3 },
          },
          additionalProperties: false,
        },
        limit: { type: 'integer', minimum: 1, maximum: 400, description: 'Default 150.' },
        include_isolated: { type: 'boolean', description: 'Also report whole separate pieces with no painted neighbours (a separate button, a wristband). Default false.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'render_uv',
    description:
      'Render the whole UV unwrap of a mesh as a PNG: the current paint, every triangle edge, ' +
      'and the patches from the last find_patches outlined in magenta with their ids. Shows ' +
      'at once what each polygon is painted with.',
    inputSchema: {
      type: 'object',
      properties: {
        mesh: { type: ['integer', 'string'] },
        size: { type: 'integer', minimum: 256, maximum: 2048, description: 'Default 1024.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'undo',
    description: 'Undo your own last fills (AI steps only — the user\'s own work is never undone). Use it instead of painting over a mistake.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 1.' } },
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
  // Детали — связные куски геометрии целиком (излом любой): у моделей из
  // Blender это обычно смысловые части — ботинок, напульсник, пуговица.
  const parts = { regions: split('geom', REGION_ANGLE), islands: split('uv', 180), pieces: split('geom', 180) };
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

/** Точка внутри рамки; null на стороне рамки — сторона открыта. */
function inBox(x, y, z, box) {
  if (!box) return true;
  const lo = box.min || [], hi = box.max || [];
  const v = [x, y, z];
  for (let i = 0; i < 3; i++) {
    if (typeof lo[i] === 'number' && v[i] < lo[i]) return false;
    if (typeof hi[i] === 'number' && v[i] > hi[i]) return false;
  }
  return true;
}
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

/* ── Пятна одного цвета ─────────────────────────────────────────── */

/** Цвет каждого треугольника — тексель итоговой карты под его центром в развёртке. */
function triColors(target, cache) {
  const S = target.size, px = target.composite;
  const { uv, idx, triCount } = cache;
  const out = new Uint8Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const u = (uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3;
    const v = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3;
    const x = Math.min(S - 1, Math.max(0, Math.floor(u * S)));
    const y = Math.min(S - 1, Math.max(0, Math.floor((1 - v) * S)));
    const o = (y * S + x) * 4;
    out[t * 3] = px[o]; out[t * 3 + 1] = px[o + 1]; out[t * 3 + 2] = px[o + 2];
  }
  return out;
}

/** Похожи ли цвета: заливки ровные, а тени в карте нет — порог небольшой. */
const SAME = 36;
const близко = (c, i, j) => Math.abs(c[i * 3] - c[j * 3]) + Math.abs(c[i * 3 + 1] - c[j * 3 + 1]) + Math.abs(c[i * 3 + 2] - c[j * 3 + 2]) <= SAME;

/**
 * Разбить меш на связные куски одного цвета — по смежности через сварку,
 * то есть поперёк швов развёртки: на модели это один кусок.
 */
function colorPieces(cache, col) {
  const n = cache.triCount, adj = cache.adjGeom;
  const piece = new Int32Array(n).fill(-1);
  const list = [];
  for (let s = 0; s < n; s++) {
    if (piece[s] >= 0) continue;
    const id = list.length, tris = [s];
    piece[s] = id;
    for (let k = 0; k < tris.length; k++) {
      const t = tris[k];
      for (let e = 0; e < 3; e++) {
        const m = adj[t * 3 + e];
        if (m < 0 || piece[m] >= 0 || !близко(col, t, m)) continue;
        piece[m] = id;
        tris.push(m);
      }
    }
    list.push(tris);
  }
  return { piece, list };
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
  /** Пятна последнего find_patches: номер → { mesh, tris, center }. */
  let lastPatches = new Map();
  /**
   * Чем ИИ закрасил каждый треугольник в этом сеансе: 1 — широко (высота,
   * рамка, сторона, весь меш), 2 — прицельно (деталь, область, пятно,
   * точка на снимке). 0 — не трогал. Стек шагов — чтобы undo вернул и память.
   */
  const kinds = new WeakMap();          // меш → Uint8Array
  const kindSteps = [];                 // [{ mesh, tris, prev: Uint8Array }]
  const kindOf = (mesh) => {
    if (!kinds.has(mesh)) kinds.set(mesh, new Uint8Array(mesh.userData.paintCache.triCount));
    return kinds.get(mesh);
  };
  const KIND = ['none', 'broad', 'detail'];

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
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) {
      for (let i = 0; i < 3; i++) {
        const v = geo.center[t * 3 + i];
        if (v < lo[i]) lo[i] = v;
        if (v > hi[i]) hi[i] = v;
      }
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
      // Разброс центров треугольников: у одной грани он ноль, это нормально.
      size: [r3(hi[0] - lo[0]), r3(hi[1] - lo[1]), r3(hi[2] - lo[2])],
      min: lo.map(r3), max: hi.map(r3),
      color: averageColor(target, cache, tris),
    };
    if (mats.size === 1) out.material = [...mats][0];
    else if (mats.size > 1) out.materials = [...mats];
    // Почти плоская поверхность в разные стороны (сфера, цилиндр) — нормаль
    // средняя ничего не говорит, отметим это словами.
    if (nl / k < 0.5) out.curved = true;
    return out;
  }

  /**
   * Части по убыванию площади, с отбором и постранично. Отбор по рамке и
   * стороне — по центру и средней нормали части.
   */
  function listParts(list, geo, total, names, target, cache, f = {}) {
    const limit = Math.min(500, Math.max(1, f.limit || MAX_LISTED));
    const offset = Math.max(0, f.offset || 0);
    const dir = f.facing ? FACING.find(([n]) => n === f.facing)?.[1] : null;
    const matched = [];
    for (let i = 0; i < list.length; i++) {
      const tris = list[i];
      if (f.min_triangles && tris.length < f.min_triangles) continue;
      if (f.box || dir) {
        let a = 0, cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
        for (const t of tris) {
          const w = geo.area[t];
          a += w;
          cx += geo.center[t * 3] * w; cy += geo.center[t * 3 + 1] * w; cz += geo.center[t * 3 + 2] * w;
          nx += geo.normal[t * 3] * w; ny += geo.normal[t * 3 + 1] * w; nz += geo.normal[t * 3 + 2] * w;
        }
        a = a || 1;
        if (!inBox(cx / a, cy / a, cz / a, f.box)) continue;
        if (dir) {
          const nl = Math.hypot(nx, ny, nz) || 1;
          if ((nx * dir[0] + ny * dir[1] + nz * dir[2]) / nl < Math.SQRT1_2) continue;
        }
      }
      matched.push(i);
    }
    const areas = new Map(matched.map((i) => [i, list[i].reduce((s, t) => s + geo.area[t], 0)]));
    matched.sort((a, b) => areas.get(b) - areas.get(a));
    const page = matched.slice(offset, offset + limit).sort((a, b) => a - b);
    const out = { count: list.length, matched: matched.length };
    if (matched.length > offset + limit) out.note = `Listed ${page.length} of ${matched.length} matching, largest first; use offset ${offset + limit} for more.`;
    out.items = page.map((i) => describePart(list, i, geo, total, names, target, cache));
    return out;
  }

  function describe_model({ mesh, box, facing, min_triangles, limit, offset } = {}) {
    const filter = { box, facing, min_triangles, limit, offset };
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
        // Деталей мало и они главные — перечисляем все, крупные первыми.
        pieces: listParts(parts.pieces.list, geo, total, names, target, cache, { ...filter, limit: Math.max(filter.limit || 0, 300) }),
        regions: listParts(parts.regions.list, geo, total, names, target, cache, filter),
        // Остров на каждый треугольник — развёртка без общих рёбер (у демо
        // так): список был бы шумом, по смыслу части дают области.
        islands: parts.islands.list.length >= cache.triCount * 0.8
          ? { count: parts.islands.list.length, note: 'Every triangle is its own UV island here; use regions instead.' }
          : listParts(parts.islands.list, geo, total, names, target, cache, filter),
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
    // Пятна — готовые наборы треугольников из последнего find_patches.
    const byPatch = new Map();
    if (target.patches) {
      for (const id of target.patches) {
        const p = lastPatches.get(id);
        if (!p) throw new Error(`No patch ${id}. Call find_patches first (ids live until the next call).`);
        if (!byPatch.has(p.mesh)) byPatch.set(p.mesh, new Set());
        for (const t of p.tris) byPatch.get(p.mesh).add(t);
      }
    }
    for (const { mesh, cache } of meshes) {
      if (target.patches && !byPatch.has(mesh)) continue;
      const inPatch = byPatch.get(mesh);
      const parts = partsOf(mesh, cache);
      const geo = triGeometry(mesh, cache);
      const names = wantMat ? materialNames(mesh, cache.triCount) : null;
      const regions = target.regions ? new Set(target.regions) : null;
      const islands = target.islands ? new Set(target.islands) : null;
      const pieces = target.pieces ? new Set(target.pieces) : null;
      const set = new Set();
      for (let t = 0; t < cache.triCount; t++) {
        if (inPatch && !inPatch.has(t)) continue;
        if (regions && !regions.has(parts.regions.id[t])) continue;
        if (islands && !islands.has(parts.islands.id[t])) continue;
        if (pieces && !pieces.has(parts.pieces.id[t])) continue;
        if (wantMat && (names[t] || '').toLowerCase() !== wantMat) continue;
        if (dir) {
          const d = geo.normal[t * 3] * dir[0] + geo.normal[t * 3 + 1] * dir[1] + geo.normal[t * 3 + 2] * dir[2];
          if (d < Math.SQRT1_2) continue;
        }
        const y = geo.center[t * 3 + 1];
        if (target.box && !inBox(geo.center[t * 3], y, geo.center[t * 3 + 2], target.box)) continue;
        if (typeof target.above === 'number' && y < target.above) continue;
        if (typeof target.below === 'number' && y > target.below) continue;
        set.add(t);
      }
      if (set.size) out.push({ mesh, set });
    }
    return out;
  }

  /** Проверить цвет и слой и залить наборы треугольников. */
  function paint(hits, { color, roughness = 0.9, metalness = 0, opacity = 1, layer }, kind = 1) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color || ''));
    if (!m) throw new Error('color must be #RRGGBB.');
    const n = parseInt(m[1], 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const layers = api.layers();
    if (layer !== undefined && (layer < 0 || layer >= layers.length)) {
      throw new Error(`No layer ${layer}. Layers: ${layers.map((l) => `${l.index} "${l.name}"`).join(', ')}.`);
    }
    let total = 0;
    for (const { mesh, set } of hits) {
      const k = kindOf(mesh);
      const tris = [...set];
      kindSteps.push({ mesh, tris, prev: Uint8Array.from(tris, (t) => k[t]) });
      for (const t of tris) k[t] = kind;
      api.fillTriangles(mesh, set, {
        color: rgb,
        roughness: Math.min(1, Math.max(0, roughness)),
        metalness: Math.min(1, Math.max(0, metalness)),
        alpha: Math.min(1, Math.max(0, opacity)),
      }, layer);
      total += set.size;
    }
    api.notify('fill', total);
    return total;
  }

  function fill({ target, ...how }) {
    requireModel();
    const hits = select(target);
    if (!hits.length) throw new Error('The target matched no triangles. Check the ids with describe_model.');
    // Прицельно — когда названа сама часть; широко — когда отбор по признакам.
    const прицельно = !!(target?.pieces || target?.regions || target?.islands || target?.patches);
    paint(hits, how, прицельно ? 2 : 1);
    const { layer } = how;
    return {
      filled: hits.map(({ mesh, set }) => ({ mesh: mesh.name, triangles: set.size })),
      layer: layer ?? api.activeLayer(),
      hint: 'Call render_view to check the result.',
    };
  }

  /**
   * Поставить ракурс снимка, отдать его камеру и вернуть вид человека тем
   * же кадром — на экране он не мелькнёт. Одна функция на снимок и на
   * точки `fill_at`: иначе пиксель указывал бы мимо того, что ИИ видел.
   */
  function withView(view, W, H, fn) {
    if (!VIEWS.includes(view)) throw new Error(`view must be one of ${VIEWS.join(', ')}.`);
    const было = viewport.viewState();
    try {
      if (view !== 'current') {
        viewport.setView(view === 'three-quarter' ? 'user' : view);
        viewport.centerCamera?.();
      }
      return fn(viewport.snapshotCamera(W, H));
    } finally {
      viewport.setViewState(было);
    }
  }

  const size = (v, def) => Math.min(2048, Math.max(64, (v | 0) || def));

  async function render_view({ view = 'three-quarter', width, height, grid = false, wire = false, flat = false, patches = false } = {}) {
    requireModel();
    const W = size(width, 768), H = size(height, 576);
    let метки = [];
    const img = withView(view, W, H, (cam) => {
      // Каркас и «плоско» — только на время снимка: у человека на экране ничего не меняется.
      const былКаркас = viewport.verticesVisible, былРежим = viewport.displayMode;
      try {
        if (wire) viewport.setVerticesVisible(true);
        if (flat) viewport.setDisplayMode('flat');
        if (patches) метки = visiblePatches(cam, W, H);
        return viewport.renderView(W, H, 2, { overlay: wire });
      } finally {
        if (wire && !былКаркас) viewport.setVerticesVisible(false);
        if (flat && былРежим !== 'flat') viewport.setDisplayMode(былРежим);
      }
    });
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
    if (grid) {
      // Сетка с подписями в пикселях — чтобы указывать точки для fill_at.
      g.strokeStyle = 'rgba(0,255,255,0.35)';
      g.fillStyle = 'rgba(0,255,255,0.9)';
      g.font = `${Math.max(10, Math.round(W / 70))}px sans-serif`;
      g.lineWidth = 1;
      for (let k = 1; k < 10; k++) {
        const x = Math.round((W * k) / 10) + 0.5, y = Math.round((H * k) / 10) + 0.5;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
        g.fillText(String(Math.round((W * k) / 10)), x + 2, 12);
        g.fillText(String(Math.round((H * k) / 10)), 2, y - 2);
      }
    }
    if (метки.length) {
      g.lineWidth = 2;
      g.font = `bold ${Math.max(11, Math.round(W / 64))}px sans-serif`;
      for (const { id, x, y } of метки) {
        g.strokeStyle = '#ff2bd6';
        g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#000';
        g.fillText(String(id), x + 9, y - 5);
        g.fillStyle = '#ff2bd6';
        g.fillText(String(id), x + 8, y - 6);
      }
    }
    const data = c.toDataURL('image/png').split(',')[1];
    return { image: data, mimeType: 'image/png', view, width: W, height: H,
      ...(patches ? { marked: метки.map((m) => m.id), hidden: [...lastPatches.keys()].filter((id) => !метки.some((m) => m.id === id)).length } : {}) };
  }

  /**
   * Пятна, которые видны с этой камеры: центр пятна в кадре и первый луч
   * к нему упирается в само пятно, а не в то, что перед ним.
   */
  function visiblePatches(cam, W, H) {
    const meshes = viewport.paintables.map((p) => p.mesh);
    const out = [];
    const v = new THREE.Vector3();
    for (const [id, p] of lastPatches) {
      v.fromArray(p.center).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      ray.setFromCamera(new THREE.Vector2(v.x, v.y), cam);
      const h = ray.intersectObjects(meshes, false)[0];
      if (!h || h.object !== p.mesh || !p.set.has(h.faceIndex)) continue;
      out.push({ id, x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H });
    }
    return out;
  }

  function find_patches({ mesh, max_triangles = 12, box, limit = 150, include_isolated = false } = {}) {
    requireModel();
    lastPatches = new Map();
    const report = [];
    let found = 0;
    for (const { mesh: m, cache } of meshesFor(mesh)) {
      const target = api.targets.get(m);
      const col = triColors(target, cache);
      const { piece, list } = colorPieces(cache, col);
      const geo = triGeometry(m, cache);
      const adj = cache.adjGeom;
      for (let id = 0; id < list.length; id++) {
        const tris = list[id];
        if (tris.length > max_triangles) continue;
        let a = 0, cx = 0, cy = 0, cz = 0;
        for (const t of tris) {
          const w = geo.area[t] || 1e-9;
          a += w; cx += geo.center[t * 3] * w; cy += geo.center[t * 3 + 1] * w; cz += geo.center[t * 3 + 2] * w;
        }
        const center = [cx / a, cy / a, cz / a];
        if (!inBox(center[0], center[1], center[2], box)) continue;
        // Что вокруг: соседние куски по числу общих рёбер.
        const вокруг = new Map();
        let рёбер = 0;
        for (const t of tris) {
          for (let e = 0; e < 3; e++) {
            const n = adj[t * 3 + e];
            if (n < 0 || piece[n] === id) continue;
            рёбер++;
            вокруг.set(piece[n], (вокруг.get(piece[n]) || 0) + 1);
          }
        }
        // Отдельная деталь без соседей (пуговица, напульсник) — не пятно, а
        // целая часть: её видно и в describe_model. Без просьбы не шумим.
        if (!рёбер && !include_isolated) continue;
        let главный = -1, сколько = 0;
        for (const [k, c] of вокруг) if (c > сколько) { главный = k; сколько = c; }
        const t0 = tris[0];
        // Чем закрашено пятно: берём самое «прицельное» из его треугольников.
        const k = kindOf(m);
        let вид = 0;
        for (const t of tris) if (k[t] > вид) вид = k[t];
        const parts = partsOf(m, cache);
        const деталь = parts.pieces.id[t0];
        const всяДеталь = parts.pieces.list[деталь].length === tris.length;
        const pid = lastPatches.size;
        lastPatches.set(pid, { mesh: m, tris, set: new Set(tris), center });
        found++;
        if (report.length < limit) {
          const g = главный >= 0 ? list[главный][0] : -1;
          report.push({
            id: pid,
            mesh: m.name,
            triangles: tris.length,
            center: center.map(r3),
            facing: facingOf(geo.normal[t0 * 3], geo.normal[t0 * 3 + 1], geo.normal[t0 * 3 + 2]),
            color: hex(col[t0 * 3], col[t0 * 3 + 1], col[t0 * 3 + 2]),
            around: g >= 0 ? hex(col[g * 3], col[g * 3 + 1], col[g * 3 + 2]) : null,
            // Какую долю границы держит главный сосед: 1 — пятно целиком
            // внутри одного цвета, почти наверняка недокрас.
            aroundShare: рёбер ? Math.round((сколько / рёбер) * 100) / 100 : 0,
            enclosed: рёбер > 0 && сколько === рёбер,
            piece: деталь,
            // detail — ты сам красил его прицельно: это задуманная деталь,
            // не трогай, если она не ошибочна. broad/none — кандидат в недокрас.
            paintedBy: KIND[вид],
            ...(всяДеталь ? { wholePiece: true } : {}),
          });
        }
      }
    }
    report.sort((a, b) => b.aroundShare - a.aroundShare || a.triangles - b.triangles);
    return {
      found,
      ...(found > report.length ? { note: `Listed ${report.length} of ${found}; narrow with box or max_triangles.` } : {}),
      patches: report,
      hint: 'paintedBy "detail" means you painted it on purpose (a hole, an eye, a gem part) — keep it. ' +
        'Leftovers are "broad"/"none" patches. See them with render_view {patches:true, wire:true}; fix with fill {target:{patches:[ids]}, color: <around>}.',
    };
  }

  function render_uv({ mesh, size: S0 = 1024 } = {}) {
    requireModel();
    const [{ mesh: m, cache }] = meshesFor(mesh ?? 0);
    const target = api.targets.get(m);
    const S = Math.min(2048, Math.max(256, S0 | 0));
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#222';
    g.fillRect(0, 0, S, S);
    g.imageSmoothingEnabled = false;
    g.drawImage(target.canvas, 0, 0, S, S);
    const { uv, idx, triCount } = cache;
    const P = (vi) => [uv[vi * 2] * S, (1 - uv[vi * 2 + 1]) * S];
    // Рёбра всех треугольников — тонко: на больших моделях их тысячи.
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = triCount > 3000 ? 0.5 : 1;
    g.beginPath();
    for (let t = 0; t < triCount; t++) {
      const [a, b, d] = [P(idx[t * 3]), P(idx[t * 3 + 1]), P(idx[t * 3 + 2])];
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(d[0], d[1]); g.closePath();
    }
    g.stroke();
    // Пятна последнего find_patches — обводка и номер.
    g.strokeStyle = '#ff2bd6';
    g.lineWidth = 2;
    g.font = `bold ${Math.round(S / 70)}px sans-serif`;
    let помечено = 0;
    for (const [id, p] of lastPatches) {
      if (p.mesh !== m) continue;
      let sx = 0, sy = 0;
      g.beginPath();
      for (const t of p.tris) {
        const [a, b, d] = [P(idx[t * 3]), P(idx[t * 3 + 1]), P(idx[t * 3 + 2])];
        g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(d[0], d[1]); g.closePath();
        sx += (a[0] + b[0] + d[0]) / 3; sy += (a[1] + b[1] + d[1]) / 3;
      }
      g.stroke();
      g.fillStyle = '#ff2bd6';
      g.fillText(String(id), sx / p.tris.length + 4, sy / p.tris.length - 4);
      помечено++;
    }
    return { image: c.toDataURL('image/png').split(',')[1], mimeType: 'image/png', mesh: m.name, size: S, patches: помечено };
  }

  const ray = new THREE.Raycaster();

  function fill_at({ view = 'three-quarter', width, height, points, angle = 30, box, dry_run = false, ...how }) {
    requireModel();
    const W = size(width, 768), H = size(height, 576);
    const a = Math.min(180, Math.max(0, +angle || 0));
    const meshes = viewport.paintables.map((p) => p.mesh);
    const hitsAt = withView(view, W, H, (cam) => points.map(({ x, y }) => {
      ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), cam);
      const h = ray.intersectObjects(meshes, false)[0];
      return h ? { mesh: h.object, tri: h.faceIndex } : null;
    }));

    const sets = new Map();        // меш → набор треугольников
    const report = [];
    hitsAt.forEach((h, k) => {
      const p = points[k];
      if (!h || h.tri == null) { report.push({ x: p.x, y: p.y, hit: false }); return; }
      const cache = h.mesh.userData.paintCache;
      const parts = partsOf(h.mesh, cache);
      let set = floodFaces(cache, h.tri, a, 'geom');
      if (box) {
        const geo = triGeometry(h.mesh, cache);
        set = new Set([...set].filter((t) => inBox(geo.center[t * 3], geo.center[t * 3 + 1], geo.center[t * 3 + 2], box)));
      }
      if (!sets.has(h.mesh)) sets.set(h.mesh, new Set());
      for (const t of set) sets.get(h.mesh).add(t);
      const geo = triGeometry(h.mesh, cache);
      const tr = api.targets.get(h.mesh);
      report.push({
        x: p.x, y: p.y, hit: true, mesh: h.mesh.name,
        piece: parts.pieces.id[h.tri],
        region: parts.regions.id[h.tri],
        triangles: set.size,
        point: [r3(geo.center[h.tri * 3]), r3(geo.center[h.tri * 3 + 1]), r3(geo.center[h.tri * 3 + 2])],
        color: averageColor(tr, cache, [h.tri]),
      });
    });

    const hits = [...sets].map(([mesh, set]) => ({ mesh, set })).filter((x) => x.set.size);
    if (!dry_run) {
      if (!hits.length) throw new Error('No point hit the model. Check the pixels against the same render_view (view, width, height).');
      if (!how.color) throw new Error('color is required unless dry_run is true.');
      paint(hits, how, 2);
    }
    return { dry_run, points: report, filled: dry_run ? 0 : hits.reduce((n, x) => n + x.set.size, 0) };
  }

  function undo({ steps = 1 } = {}) {
    requireModel();
    const h = api.history;
    let done = 0;
    for (let k = 0; k < Math.min(20, Math.max(1, steps | 0)); k++) {
      const e = h.entries[h.index];
      if (!e || e.label !== 'act.aiFill') break;   // чужую работу не трогаем
      h.undo();
      const ks = kindSteps.pop();
      if (ks) { const k = kindOf(ks.mesh); ks.tris.forEach((t, i) => { k[t] = ks.prev[i]; }); }
      done++;
    }
    if (!done) throw new Error('Nothing to undo: the last step is not yours (or there are no steps).');
    return { undone: done };
  }

  function new_layer({ name } = {}) {
    requireModel();
    const index = api.addLayer(name ? String(name).slice(0, 60) : null);
    return { layer: index, layers: api.layers() };
  }

  const handlers = { describe_model, render_view, find_patches, render_uv, fill, fill_at, undo, new_layer };

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
            { type: 'text', text: JSON.stringify(Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'image' && k !== 'mimeType'))) },
          ] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 1) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err?.message || err) }], isError: true };
      }
    },
  };
}

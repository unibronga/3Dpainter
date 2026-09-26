/**
 * Вьюпорт: сцена, камера, орбита, загрузка модели и попадание луча в
 * поверхность. Всё, что связано с показом, живёт здесь; покраска о three.js
 * знает только через попадание луча.
 */

import { t } from './i18n.js';

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildMeshCache, measureUVOverlap } from './mesh-cache.js';
import { uvVerdict, buildUV } from './unwrap.js';

/**
 * Цвета материалов меша — диапазонами треугольников.
 *
 * Группы геометрии заданы в вершинах, поэтому границы делятся на три. Групп
 * может не быть вовсе: тогда весь меш — один материал.
 *
 * @returns {Array<{from:number, to:number, rgb:number[]}>}
 */
function sourceGroups(mesh, triCount) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const цвет = (m) => {
    if (!m || !m.color) return null;
    const hex = m.color.getHex(THREE.SRGBColorSpace);
    return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  };
  const groups = mesh.geometry.groups?.length
    ? mesh.geometry.groups
    : [{ start: 0, count: triCount * 3, materialIndex: 0 }];

  const out = [];
  for (const g of groups) {
    const rgb = цвет(mats[g.materialIndex ?? 0] || mats[0]);
    if (!rgb) continue;
    const from = Math.max(0, Math.floor(g.start / 3));
    const to = Math.min(triCount, Math.floor((g.start + g.count) / 3));
    if (to > from) out.push({ from, to, rgb });
  }
  return out;
}
import { buildDemoMesh } from './demo.js';

/**
 * Вшить показ выделения в материал.
 *
 * Край ищется по производной маски: там, где она переходит через середину,
 * рисуется пунктир шириной около двух пикселей экрана при любом зуме.
 * Верхний предел ширины держим ниже половины — иначе издали, когда тексель
 * мельче пикселя, «краем» стала бы вся выделенная площадь.
 */
/* ── Снимок вида ───────────────────────────────────────────────── */

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const linToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

/**
 * Уменьшить снимок в ss раз и перевернуть по вертикали (видеокарта отдаёт
 * строки снизу вверх).
 *
 * Край модели на прозрачном фоне приходит «умноженным на покрытие»: цвет
 * полупрозрачного пикселя уже смешан с чёрной очисткой. Поэтому усредняем в
 * линейном свете вместе с альфой, а потом делим цвет обратно на покрытие —
 * иначе по контуру модели легла бы тёмная кайма.
 */
function shrinkPremultiplied(buf, w, h, ss) {
  const W = w / ss, H = h / ss;
  const out = new ImageData(W, H);
  const d = out.data;
  const n = ss * ss;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < ss; j++) {
        const row = (h - 1 - (y * ss + j)) * w;
        for (let i = 0; i < ss; i++) {
          const o = (row + x * ss + i) * 4;
          r += SRGB_TO_LIN[buf[o]];
          g += SRGB_TO_LIN[buf[o + 1]];
          b += SRGB_TO_LIN[buf[o + 2]];
          a += buf[o + 3];
        }
      }
      const q = (y * W + x) * 4;
      if (a <= 0) continue;              // прозрачно — ImageData уже нули
      const k = 255 / a;                 // обратно из «умноженного на покрытие»
      d[q] = linToSrgb(r * k);
      d[q + 1] = linToSrgb(g * k);
      d[q + 2] = linToSrgb(b * k);
      d[q + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Скорость вращения: полный оборот на 500 пикселей протяжки. */
export const ORBIT_SPEED = (2 * Math.PI) / 500;

function patchSelection(material, u) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = 'uniform sampler2D selMap;\nuniform float selOn;\nuniform float selTime;\n'
      + sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
      if (selOn > 0.5) {
        // Маска лежит строками сверху вниз, как холст покраски, но холст
        // three.js переворачивает при заливке (flipY), а сырые данные — нет.
        float s = texture2D(selMap, vec2(vMapUv.x, 1.0 - vMapUv.y)).r;
        float w = clamp(fwidth(s), 1e-4, 0.24);
        float edge = 1.0 - smoothstep(w, w * 2.0, abs(s - 0.5));
        float dash = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0 - selTime));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dash), edge);
      }`);
  };
  material.customProgramCacheKey = () => 'paint-sel';
}

export class Viewport {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Тональной компрессии нет намеренно: в инструменте покраски цвет на
    // экране должен совпадать с цветом в палитре, а не «киношно» гаситься.
    this.renderer.toneMapping = THREE.NoToneMapping;

    // Полотно вьюпорта кладём ПЕРВЫМ и помечаем классом: внутри #viewport
    // лежит ещё и полотно куба ориентации, и без явного различия под общий
    // селектор попадали оба.
    this.renderer.domElement.className = 'viewport-canvas';
    container.insertBefore(this.renderer.domElement, container.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15171a);

    // Две камеры живут одновременно, переключение — подмена активной: так
    // ортография не теряет положение, набранное в перспективе.
    this.perspCamera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
    this.perspCamera.position.set(6, 5, 8);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
    this.orthoCamera.position.copy(this.perspCamera.position);
    this.camera = this.perspCamera;
    this.projection = 'persp';

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    // Раскладка владельца: левая кнопка отдана инструменту целиком,
    // вращение — правая, сдвиг — средняя, зум — колесо.
    // Вращение и зум делаем сами: у OrbitControls точка взгляда и точка
    // вращения — одна и та же, а нам нужно вращать вокруг произвольной,
    // не трогая кадр. За ним остаётся сдвиг вида и сглаживание.
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: null,
    };
    this.controls.enableZoom = false;
    this._bindNavigation();

    this._buildEnvironment();
    this._buildLights();
    this._buildHelpers();
    this._buildCursor();
    this._buildPivotMarker();

    this.model = null;
    this.paintables = [];   // [{mesh, cache}]
    this.displayMode = 'material';
    this.gridVisible = true;
    this.verticesVisible = false;
    // Вокруг чего вращаем и приближаем: мир, центр объекта или точка взгляда.
    this.pivotMode = 'local';
    this.afterRender = null; // крючок для куба ориентации

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    // Выделение показывается в самом материале меша бегущим пунктиром по
    // краю. Затемнения снаружи нет: оно заставляло мигать всю модель в миг,
    // когда выделение появлялось. Время у всех мешей общее — пунктир бежит
    // в ногу. Пустышка стоит там, где выделения нет.
    this._selTime = { value: 0 };
    this._selDummy = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
    this._selDummy.needsUpdate = true;

    this._observer = new ResizeObserver(() => this.resize());
    this._observer.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => this._tick());
  }

  /**
   * Карта окружения. Нужна ровно из-за металла: у металлической поверхности
   * нет диффузной составляющей, она видна только отражением, и без окружения
   * покрашенное железо выходит чёрным пятном.
   *
   * Яркость держим умеренной — инструмент про цвет, и подмешивать в него
   * много отражённого света нельзя.
   */
  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
  }

  _buildLights() {
    // Свет ровный и нейтральный: кисть должна ложиться тем цветом, который
    // выбран, а не тем, который вылепила подсветка.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.05));

    const hemi = new THREE.HemisphereLight(0xffffff, 0x60646c, 0.8);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 9, 6);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-6, 3, -5);
    this.scene.add(fill);
  }

  _buildHelpers() {
    this.grid = this._makeGrid(20);
    this.scene.add(this.grid);
  }

  /** Кольцо на поверхности — показывает, куда и какого размера ляжет мазок. */
  _buildCursor() {
    const N = 64;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false });
    this.cursor = new THREE.Line(geo, mat);
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    this.scene.add(this.cursor);
  }

  /**
   * Значок точки вращения — как 3D-курсор в Blender: видно, вокруг чего
   * поворачивается вид. Рисуется спрайтом поверх модели (`depthTest: false`),
   * иначе точка на дальней стороне пряталась бы внутри меша, а она нужна
   * именно тогда, когда непонятно, где она.
   */
  _buildPivotMarker() {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const r = S * 0.3;
    const mid = S / 2;

    // Тёмная подложка под всем рисунком: без неё белые части значка
    // пропадают на светлой модели, а именно там он и нужен чаще всего.
    const контур = (рисовать) => {
      g.strokeStyle = 'rgba(20, 20, 24, 0.85)';
      g.lineWidth = S * 0.095;
      рисовать();
      g.lineWidth = S * 0.05;
    };

    const кольцо = (от, до) => { g.beginPath(); g.arc(mid, mid, r, от, до); g.stroke(); };
    контур(() => кольцо(0, Math.PI * 2));

    // Кольцо в белую и красную четверть — читается и на светлой модели,
    // и на тёмном фоне, в отличие от однотонного.
    for (let i = 0; i < 8; i++) {
      g.strokeStyle = i % 2 ? '#ffffff' : '#d0674f';
      кольцо((i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
    }

    // Перекрестие: короткие штрихи от кольца наружу.
    const штрихи = () => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        g.beginPath();
        g.moveTo(mid + dx * r * 1.3, mid + dy * r * 1.3);
        g.lineTo(mid + dx * r * 2.05, mid + dy * r * 2.05);
        g.stroke();
      }
    };
    контур(штрихи);
    g.strokeStyle = '#ffffff';
    g.lineWidth = S * 0.04;
    штрихи();

    // Ядро — чтобы сама точка была видна, а не только кольцо вокруг неё.
    g.beginPath();
    g.fillStyle = 'rgba(20, 20, 24, 0.85)';
    g.arc(mid, mid, S * 0.075, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.fillStyle = '#ffffff';
    g.arc(mid, mid, S * 0.045, 0, Math.PI * 2);
    g.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
    this.pivotMarker = new THREE.Sprite(mat);
    this.pivotMarker.renderOrder = 1000;
    this.pivotMarker.visible = false;
    this.scene.add(this.pivotMarker);
    this._pivotHideTimer = null;
  }

  /** Показать значок в точке; сам спрячется, когда жест кончится. */
  showPivotMarker(point) {
    if (!point || !this.pivotMarker) return;
    clearTimeout(this._pivotHideTimer);
    this._pivotHideTimer = null;
    this.pivotMarker.position.copy(point);
    this.pivotMarker.visible = true;
  }

  /** Спрятать — с задержкой, чтобы значок не мигал между движениями колеса. */
  hidePivotMarker(delay = 700) {
    if (!this.pivotMarker) return;
    clearTimeout(this._pivotHideTimer);
    this._pivotHideTimer = setTimeout(() => {
      this.pivotMarker.visible = false;
      this._pivotHideTimer = null;
    }, delay);
  }

  /** Держать значок одного размера на экране, как бы близко ни стояла камера. */
  _syncPivotMarker() {
    const m = this.pivotMarker;
    if (!m || !m.visible) return;

    const px = 34;                       // желаемый размер значка в пикселях
    const h = this.renderer.domElement.clientHeight || 1;
    const cam = this.camera;

    const span = cam.isOrthographicCamera
      ? (cam.top - cam.bottom) / cam.zoom
      : 2 * cam.position.distanceTo(m.position) * Math.tan((cam.fov * Math.PI) / 360);

    m.scale.setScalar((px / h) * span);
  }

  /* ── Модель ──────────────────────────────────────────────────── */

  loadDemo() {
    const g = new THREE.Group();
    g.add(buildDemoMesh());
    return this.setModel(g, () => t('model.demo'));
  }

  async loadGLB(arrayBuffer, name) {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuffer, '');
    return this.setModel(gltf.scene, name);
  }

  /**
   * Открыть файл модели любого поддерживаемого формата. Загрузчик выбирается
   * по расширению; сама сцена дальше живёт одинаково, откуда бы ни пришла.
   */
  async loadFile(arrayBuffer, name, спутники = null) {
    const { parseModel } = await import('./formats.js');
    const object = await parseModel(arrayBuffer, name, спутники);
    return this.setModel(object, name);
  }

  /**
   * Поставить модель в сцену. Возвращает отчёт: что удалось взять в покраску,
   * а что нет — меш без развёртки красить нечем, об этом надо сказать вслух.
   */
  setModel(object3D, name = t('model.default')) {
    this.clearModel();

    this.model = object3D;
    this.scene.add(object3D);

    const report = { name, meshes: 0, tris: 0, noUV: [], overlapping: [], unwrapped: [] };

    object3D.traverse((o) => {
      if (!o.isMesh) return;

      // Развёртка — условие работы, а не украшение: красим-то по текселям.
      // Модели из интернета его сплошь и рядом не выполняют, и тогда строим
      // свою. Старую геометрию не освобождаем: её может делить другой меш.
      const verdict = uvVerdict(o.geometry);
      if (!verdict.ok) {
        const built = buildUV(o.geometry);
        o.geometry = built.geometry;
        report.unwrapped.push({
          name: o.name || t('model.unnamed'),
          reason: verdict.reason,
          islands: built.islands,
        });
      }

      const cache = buildMeshCache(o.geometry);
      if (!cache) {
        report.noUV.push(o.name || t('model.unnamed'));
        o.material = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 1 });
        return;
      }
      o.userData.paintCache = cache;
      // Цвета материалов из файла — пока материал не подменён нашим. Кладём
      // их диапазонами треугольников: дальше из них выпекается первый слой.
      if (object3D.userData.materialsFromFile) {
        o.userData.sourceGroups = sourceGroups(o, cache.triCount);
      }
      this.paintables.push({ mesh: o, cache });
      report.meshes += 1;
      report.tris += cache.triCount;
    });

    this.frameModel();
    if (this.verticesVisible) this.setVerticesVisible(true);

    // Наложения меряем после кадрирования: порог берём от габарита модели.
    const tol = Math.max(0.01, (this.modelSize || 1) * 0.02);
    for (const { mesh, cache } of this.paintables) {
      const ov = measureUVOverlap(cache, tol);
      cache.overlap = ov.ratio;
      if (ov.ratio > 0.02) report.overlapping.push({ name: mesh.name || t('model.unnamed'), ratio: ov.ratio });
    }

    return report;
  }

  clearModel() {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m && m.dispose());
    });
    this.model = null;
    this.paintables = [];
  }

  /** Подогнать камеру и сетку под габариты модели. */
  frameModel(keepDirection = false) {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    const fov = this.perspCamera.fov;
    const dist = (maxDim / 2) / Math.tan((fov * Math.PI) / 360) * 1.7;

    // Направление либо новое (3/4), либо то, что уже набрано — так
    // «Центрировать» не сбивает выбранный ракурс.
    const dir = keepDirection
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(0.75, 0.5, 1).normalize();

    this.controls.target.copy(center);

    // Ближняя плоскость не должна быть бесконечно близкой: при far/near в
    // десятки тысяч глубина грубеет и тонкие накладки (дверь в сантиметре от
    // стены) начинают полосить.
    this.perspCamera.position.copy(center).addScaledVector(dir, dist);
    this.perspCamera.near = maxDim / 500;
    this.perspCamera.far = dist * 8;
    this.perspCamera.updateProjectionMatrix();

    this.orthoCamera.position.copy(this.perspCamera.position);
    this.orthoCamera.near = -maxDim * 8;
    this.orthoCamera.far = maxDim * 8;
    this.orthoCamera.zoom = 1;
    this._updateOrthoFrustum(maxDim * 1.25);

    this.modelSize = maxDim;
    this.controls.update();

    // Сетка по земле модели, шаг ровно метр.
    const span = Math.max(4, Math.ceil(maxDim * 2));
    this.scene.remove(this.grid);
    this.grid = this._makeGrid(span);
    this.grid.position.y = box.min.y;
    this.grid.visible = this.gridVisible !== false;
    this.scene.add(this.grid);

    return maxDim;
  }

  /** Сетка пола. Цвета светлее фона настолько, чтобы читались, но не спорили
   *  с моделью: центральные оси ярче остальных линий. */
  _makeGrid(span) {
    const g = new THREE.GridHelper(span, span, 0x9aa2ad, 0x5a626c);
    g.material.transparent = true;
    g.material.opacity = 0.85;
    g.material.depthWrite = false;
    return g;
  }

  /* ── Показ вершин ────────────────────────────────────────────── */

  /**
   * Сетка модели поверх поверхности: все рёбра плюс точки в вершинах —
   * ровно то, что видно в развёртке. По ней сразу понятно, насколько мелко
   * нарезана форма и докуда дотянется заливка по граням.
   */
  setVerticesVisible(on) {
    this.verticesVisible = on;
    for (const { mesh } of this.paintables) {
      let ov = mesh.userData.meshOverlay;

      if (on && !ov) {
        ov = new THREE.Group();

        // WireframeGeometry берёт каждое ребро треугольника, включая
        // диагонали четырёхугольников — как и рисует панель развёртки.
        const wire = new THREE.LineSegments(
          new THREE.WireframeGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({
            color: 0x5fd0ff,
            transparent: true,
            opacity: 0.75,
            // Чуть придвигаем к камере, иначе линии тонут в самой поверхности.
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
          }),
        );

        const pts = new THREE.Points(mesh.geometry, new THREE.PointsMaterial({
          color: 0xffc36b,
          size: 6,
          sizeAttenuation: false,   // одинаковый размер на любом удалении
          depthTest: true,
        }));

        ov.add(wire, pts);
        ov.renderOrder = 5;
        mesh.add(ov);
        mesh.userData.meshOverlay = ov;
      }

      if (ov) ov.visible = on;
    }
  }

  /* ── Камеры: проекция и виды ─────────────────────────────────── */

  _updateOrthoFrustum(height) {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    const halfH = (height ?? this._orthoHeight ?? 4) / 2;
    this._orthoHeight = halfH * 2;
    const c = this.orthoCamera;
    c.top = halfH; c.bottom = -halfH;
    c.left = -halfH * aspect; c.right = halfH * aspect;
    c.updateProjectionMatrix();
  }

  /** @param {'persp'|'ortho'} kind */
  setProjection(kind) {
    if (kind === this.projection) return;
    const from = this.camera;
    const to = kind === 'ortho' ? this.orthoCamera : this.perspCamera;
    const target = this.controls.target;
    const dist = from.position.distanceTo(target);

    if (kind === 'ortho') {
      // Подбираем рамку ортографии под то, что сейчас видно в перспективе.
      const visible = 2 * Math.tan((this.perspCamera.fov * Math.PI) / 360) * dist;
      to.position.copy(from.position);
      to.quaternion.copy(from.quaternion);
      to.zoom = 1;
      this._updateOrthoFrustum(visible);
    } else {
      // Обратно: отодвигаем перспективу так, чтобы кадр совпал.
      const visible = (this._orthoHeight || 4) / (this.orthoCamera.zoom || 1);
      const need = (visible / 2) / Math.tan((to.fov * Math.PI) / 360);
      const dir = from.position.clone().sub(target).normalize();
      to.position.copy(target).addScaledVector(dir, need);
      to.quaternion.copy(from.quaternion);
      to.updateProjectionMatrix();
    }

    this.camera = to;
    this.projection = kind;
    this.controls.object = to;
    this.controls.update();
  }

  /**
   * Встать на стандартный вид. Расстояние до цели сохраняется.
   * @param {'front'|'back'|'left'|'right'|'top'|'bottom'|'user'} name
   */
  setView(name) {
    const DIRS = {
      front: [0, 0, 1], back: [0, 0, -1],
      right: [1, 0, 0], left: [-1, 0, 0],
      top: [0, 1, 0], bottom: [0, -1, 0],
      user: [0.75, 0.5, 1],
    };
    this.setViewDirection(new THREE.Vector3(...(DIRS[name] || DIRS.user)));
  }

  /**
   * Встать на произвольное направление взгляда — этим пользуется куб
   * ориентации, где щелчок по ребру или углу даёт не осевой вид.
   * @param {THREE.Vector3} dir — откуда смотрим, в мировых осях
   */
  setViewDirection(dir) {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target) || (this.modelSize || 4);
    const d = dir.clone().normalize();

    // Прямо сверху и прямо снизу «вверх экрана» по Y не определён — берём Z.
    const straightUp = Math.abs(d.y) > 0.999;
    this.camera.up.set(0, 1, 0);
    if (straightUp) this.camera.up.set(0, 0, d.y > 0 ? -1 : 1);

    this.camera.position.copy(target).addScaledVector(d, dist);
    this.camera.lookAt(target);
    this.controls.update();
  }

  /** Имя стандартного вида, если камера стоит ровно на нём. */
  currentViewName() {
    const d = this.camera.position.clone().sub(this.controls.target).normalize();
    const NAMED = {
      front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0],
      left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0],
    };
    for (const [name, v] of Object.entries(NAMED)) {
      if (d.dot(new THREE.Vector3(...v)) > 0.9995) return name;
    }
    return 'user';
  }

  setGridVisible(on) { this.grid.visible = on; this.gridVisible = on; }

  /* ── Точка вращения ──────────────────────────────────────────── */

  /** Центр габаритов модели в мировых координатах. */
  modelCenter() {
    const c = new THREE.Vector3();
    if (this.model) new THREE.Box3().setFromObject(this.model).getCenter(c);
    return c;
  }

  /**
   * Сменить точку вращения. Камеру не трогаем совсем: меняется только то,
   * вокруг чего крутится и приближается вид, а кадр остаётся как был.
   * @param {'world'|'local'|'camera'} mode
   */
  setPivotMode(mode) { this.pivotMode = mode; }

  /**
   * Точка, вокруг которой вращаем и приближаем.
   *
   * 🔴 Для режима «камера» это не `controls.target`, а точка поверхности под
   * центром кадра. Точка взгляда висит на той глубине, где её оставил
   * предыдущий сдвиг: подведя предмет в центр экрана, человек видит его в
   * прицеле, но вращение идёт вокруг пустоты перед ним или за ним, и предмет
   * уезжает вбок. Луч из центра кадра берёт настоящую глубину того, на что
   * смотрят. Луч мимо модели (пустое место в центре) — откат на точку взгляда.
   */
  pivotPoint() {
    if (this.pivotMode === 'world') return new THREE.Vector3(0, 0, 0);
    if (this.pivotMode === 'local') return this.modelCenter();
    return this.centerSurfacePoint() || this.controls.target.clone();
  }

  /** Точка модели под центром кадра, либо null, если там пусто. */
  centerSurfacePoint() {
    const r = this.renderer.domElement.getBoundingClientRect();
    const hit = this.pick(r.left + r.width / 2, r.top + r.height / 2);
    return hit ? hit.world.clone() : null;
  }

  /** Экранные пиксели точки мира — для проверки, что она осталась на месте. */
  _toScreen(v) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  /**
   * Вернуть точку туда, где она была в кадре, сдвигая связку поперёк взгляда.
   *
   * 🔴 Нужно после выпрямления камеры по мировой вертикали: выпрямление —
   * это доворот вокруг оси взгляда, и он уводит по экрану всё, что не лежит
   * в центре кадра, включая саму точку вращения. Отсюда и брался уход в
   * сотни пикселей при вертикальном вращении вокруг объекта или мира.
   * Сдвиг считается по касательной, поэтому уточняется в несколько проходов:
   * один даёт ~32 px промаха, три — сотые доли.
   */
  _keepOnScreen(point, was, passes = 3) {
    const cam = this.camera;
    const r = this.renderer.domElement.getBoundingClientRect();

    for (let i = 0; i < passes; i++) {
      const now = this._toScreen(point);
      const dx = now.x - was.x;
      const dy = now.y - was.y;
      if (Math.hypot(dx, dy) < 0.05) break;

      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();

      let k;
      if (cam.isOrthographicCamera) {
        k = (cam.top - cam.bottom) / cam.zoom / r.height;
      } else {
        const dist = cam.position.distanceTo(point);
        k = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / r.height;
      }

      cam.position.addScaledVector(right, dx * k).addScaledVector(up, -dy * k);
      this.controls.target.addScaledVector(right, dx * k).addScaledVector(up, -dy * k);
      cam.updateMatrixWorld(true);
    }
  }

  /* ── Навигация вокруг точки ──────────────────────────────────── */

  _bindNavigation() {
    const el = this.renderer.domElement;
    let drag = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;          // вращение — правая кнопка
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* не беда */ }
      // Точку берём один раз на весь жест: пересчитывай её на каждое
      // движение — под центром кадра оказывалась бы то одна поверхность, то
      // другая, и вид дёргался бы сам по себе.
      this._pivotLock = this.pivotPoint();
      this.showPivotMarker(this._pivotLock);
      drag = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.orbitBy(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    });

    const stop = () => { drag = null; this._pivotLock = null; this.hidePivotMarker(); };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      // Приближение идёт вокруг той же точки — показываем и её.
      this.showPivotMarker(this.pivotPoint());
      this.hidePivotMarker();
    }, { passive: false });
  }

  /**
   * Довернуть вид на смещение в пикселях — вокруг текущей точки вращения.
   * Крутим связку целиком: и камеру, и точку взгляда. Если вращать только
   * камеру, она перестанет смотреть туда же, и кадр поедет.
   */
  orbitBy(dx, dy, speed = ORBIT_SPEED) {
    const cam = this.camera;
    const P = this._pivotLock || this.pivotPoint();
    const target = this.controls.target;
    const wasOnScreen = this._toScreen(P);

    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * speed);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * speed);

    // Через полюс не переваливаем: там «вверх экрана» перестаёт быть определён.
    const off = cam.position.clone().sub(target);
    const afterPitch = off.clone().applyQuaternion(qPitch).normalize();
    const q = Math.abs(afterPitch.y) > 0.995 ? qYaw : qYaw.multiply(qPitch);

    const rot = (v) => v.sub(P).applyQuaternion(q).add(P);
    rot(cam.position);
    rot(target);

    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);

    // Выпрямление довернуло кадр вокруг оси взгляда — возвращаем точку на место.
    this._keepOnScreen(P, wasOnScreen);
    this.controls.update();
  }

  /**
   * Приблизить или отдалить вокруг точки вращения.
   * @param {number} scale > 1 — ближе
   */
  zoomBy(scale) {
    const cam = this.camera;
    const P = this.pivotPoint();
    const target = this.controls.target;
    const span = this.modelSize || 1;

    if (cam.isOrthographicCamera) {
      const before = cam.zoom;
      cam.zoom = Math.max(0.05, Math.min(400, cam.zoom * scale));
      const k = cam.zoom / before;
      if (k === 1) return;

      // В ортографии приближение — это сжатие рамки, камера сама по себе не
      // едет. Чтобы точка осталась на месте экрана, двигаем связку поперёк.
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
      const d = P.clone().sub(cam.position);
      const shift = right.multiplyScalar(d.dot(right) * (1 - 1 / k))
        .add(up.multiplyScalar(d.dot(up) * (1 - 1 / k)));
      cam.position.add(shift);
      target.add(shift);
      cam.updateProjectionMatrix();
    } else {
      // Подтягиваем связку к точке: направление на точку не меняется, значит
      // она остаётся ровно на своём месте в кадре, а всё вокруг наезжает.
      const f = 1 / scale;
      const dist = cam.position.distanceTo(P) * f;
      if (dist < span * 0.02 || dist > span * 60) return;
      const move = (v) => v.sub(P).multiplyScalar(f).add(P);
      move(cam.position);
      move(target);
    }
    this.controls.update();
  }

  /** Вписать модель в кадр, не трогая выбранный ракурс. */
  centerCamera() { this.frameModel(true); }

  /** Размер кадра вьюпорта в пикселях экрана — отправная точка для «Вида в PNG». */
  viewSize() {
    const c = this.renderer.domElement;
    return { w: c.width, h: c.height };
  }

  /** Самая длинная сторона, которую видеокарта примет целью рендера. */
  maxRenderSide() {
    return Math.min(this.renderer.capabilities.maxTextureSize || 4096, 16384);
  }

  /**
   * Снять текущий вид модели в картинку W×H на прозрачном фоне.
   *
   * Ракурс — ровно тот, что во вьюпорте; сетка пола, кольцо кисти, метка
   * точки вращения, каркас вершин и пунктир выделения в снимок не попадают.
   *
   * 🔴 Холст вьюпорта создан без альфы, поэтому снимаем в отдельную цель
   * рендера. Цель — sRGB: цвет кодирует видеокарта при записи, так же как
   * при выводе на экран, и покраска в снимке совпадает с палитрой. В
   * линейной цели на 8 бит тёмные тона ушли бы в ступеньки.
   *
   * @param {number} ss суперсэмплинг: снимаем в ss раз крупнее и усредняем
   * @returns {ImageData}
   */
  renderView(W, H, ss = 1) {
    const r = this.renderer;
    const w = W * ss, h = H * ss;

    // Своя камера с пропорциями снимка: если они отличаются от вьюпорта,
    // кадр шире или выше, но центр и масштаб по высоте те же.
    const cam = this.camera.clone();
    if (cam.isPerspectiveCamera) {
      cam.aspect = W / H;
    } else {
      const halfH = (cam.top - cam.bottom) / 2;
      const cx = (cam.left + cam.right) / 2;
      cam.left = cx - halfH * (W / H);
      cam.right = cx + halfH * (W / H);
    }
    cam.updateProjectionMatrix();

    const спрятано = [];
    const спрятать = (o) => { if (o && o.visible) { o.visible = false; спрятано.push(o); } };
    спрятать(this.grid);
    спрятать(this.cursor);
    спрятать(this.pivotMarker);
    const безВыделения = [];
    for (const { mesh } of this.paintables) {
      спрятать(mesh.userData.meshOverlay);
      const u = mesh.userData.selUniforms;
      if (u && u.selOn.value) { u.selOn.value = 0; безВыделения.push(u); }
    }
    const фон = this.scene.background;
    const цветОчистки = r.getClearColor(new THREE.Color());
    const альфаОчистки = r.getClearAlpha();

    const rt = new THREE.WebGLRenderTarget(w, h, {
      samples: Math.min(4, r.capabilities.maxSamples || 4),
    });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const buf = new Uint8Array(w * h * 4);
    try {
      this.scene.background = null;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    } finally {
      r.setRenderTarget(null);
      r.setClearColor(цветОчистки, альфаОчистки);
      this.scene.background = фон;
      спрятано.forEach((o) => { o.visible = true; });
      безВыделения.forEach((u) => { u.selOn.value = 1; });
      rt.dispose();
    }
    return shrinkPremultiplied(buf, w, h, ss);
  }

  /** Вернуть вид, с которым модель открылась: три четверти, модель в кадре. */
  resetView() {
    // После вида сверху или снизу «верх» камеры мог остаться по Z.
    this.perspCamera.up.set(0, 1, 0);
    this.orthoCamera.up.set(0, 1, 0);
    this.frameModel(false);
  }

  /**
   * Подменить материал меша на материал покраски.
   * Шероховатость и металл приходят картой: они красятся кистью по текселям,
   * а не задаются на весь объект.
   */
  applyPaintMaterial(mesh, target) {
    const texture = target.texture;
    const old = mesh.material;
    mesh.userData.paintTarget = target;
    mesh.userData.matMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      roughnessMap: target.ormTexture,
      metalnessMap: target.ormTexture,
      // Карта умножается на число — держим множители единичными.
      roughness: 1,
      metalness: 1,
    });
    mesh.userData.flatMaterial = new THREE.MeshBasicMaterial({ map: texture });
    const u = mesh.userData.selUniforms = {
      selMap: { value: this._selDummy }, selOn: { value: 0 }, selTime: this._selTime,
    };
    patchSelection(mesh.userData.matMaterial, u);
    patchSelection(mesh.userData.flatMaterial, u);
    mesh.material = this.displayMode === 'flat'
      ? mesh.userData.flatMaterial
      : mesh.userData.matMaterial;
    if (old && old !== mesh.material) {
      (Array.isArray(old) ? old : [old]).forEach((m) => m && m.dispose && m.dispose());
    }
  }

  /**
   * Показать выделение на меше.
   * @param {Uint8Array|null} sel маска текселей; null — выделения нет
   */
  setSelection(mesh, sel, size) {
    const u = mesh.userData.selUniforms;
    if (!u) return;
    const old = u.selMap.value;
    if (!sel) {
      u.selOn.value = 0;
      u.selMap.value = this._selDummy;
    } else {
      const tex = new THREE.DataTexture(sel, size, size, THREE.RedFormat);
      // Мягкий край между текселями: по нему шейдер и находит контур.
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      u.selMap.value = tex;
      u.selOn.value = 1;
    }
    if (old && old !== this._selDummy && old !== u.selMap.value) old.dispose();
  }

  /**
   * Начать жест вращения или приближения левой кнопкой — инструментом вида.
   *
   * Точка берётся один раз на весь жест, как и при вращении правой кнопкой:
   * пересчитывай её на каждое движение — под центром кадра оказывалась бы то
   * одна поверхность, то другая, и вид дёргался бы сам по себе.
   */
  beginNav() {
    this._pivotLock = this.pivotPoint();
    this.showPivotMarker(this._pivotLock);
  }

  endNav() {
    this._pivotLock = null;
    this.hidePivotMarker();
  }

  /** Пока зажат пробел, левая кнопка временно работает как сдвиг. */
  setLeftButtonPan(on) {
    this.controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : null;
    this.renderer.domElement.style.cursor = on ? 'grab' : '';
  }

  /**
   * Включить прозрачность там, где ею красили.
   *
   * Держим её выключенной, пока прозрачного нет: прозрачный материал уходит
   * в отдельный проход отрисовки со всеми его сложностями сортировки, и
   * платить за это без нужды незачем.
   */
  syncTransparency() {
    for (const { mesh } of this.paintables) {
      const target = mesh.userData.paintTarget;
      const mat = mesh.userData.matMaterial;
      if (!target || !mat) continue;

      const on = target.updateTransparency();
      if (mat.transparent === on) continue;

      for (const m of [mat, mesh.userData.flatMaterial]) {
        if (!m) continue;
        m.transparent = on;
        // Сквозь стекло должна быть видна изнанка модели, иначе поворот не
        // показывает ничего нового и прозрачности будто нет.
        m.side = on ? THREE.DoubleSide : THREE.FrontSide;
        m.needsUpdate = true;
      }
    }
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    for (const { mesh } of this.paintables) {
      const m = mode === 'flat' ? mesh.userData.flatMaterial : mesh.userData.matMaterial;
      if (m) mesh.material = m;
    }
  }

  /* ── Попадание луча ──────────────────────────────────────────── */

  /**
   * @returns {null|{mesh, cache, local: THREE.Vector3, world: THREE.Vector3,
   *                 viewDir: THREE.Vector3, uv: THREE.Vector2, faceIndex: number,
   *                 normalWorld: THREE.Vector3, scale: number}}
   */
  pick(clientX, clientY) {
    if (!this.paintables.length) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this._ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    this._ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this._ndc, this.camera);

    const hits = this.raycaster.intersectObjects(this.paintables.map((p) => p.mesh), false);
    if (!hits.length) return null;
    const hit = hits[0];
    const mesh = hit.object;
    const entry = this.paintables.find((p) => p.mesh === mesh);
    if (!entry) return null;

    const local = mesh.worldToLocal(hit.point.clone());
    const camLocal = mesh.worldToLocal(this.camera.position.clone());
    const viewDir = local.clone().sub(camLocal).normalize();

    const scale = mesh.getWorldScale(new THREE.Vector3());
    const uniform = Math.max(scale.x, scale.y, scale.z) || 1;

    const normalWorld = hit.face
      ? hit.face.normal.clone().transformDirection(mesh.matrixWorld)
      : new THREE.Vector3(0, 1, 0);

    // Экранные оси в системе меша — по ним ориентируются кисти с формой:
    // у круга направления нет, а квадрат должен стоять ровно по экрану.
    const inv = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
    const basis = {
      right: new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).applyMatrix3(inv).normalize(),
      up: new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).applyMatrix3(inv).normalize(),
    };

    return {
      mesh, cache: entry.cache,
      local, world: hit.point.clone(), viewDir, basis,
      uv: hit.uv, faceIndex: hit.faceIndex,
      normalWorld, scale: uniform,
    };
  }

  showCursor(hit, worldRadius) {
    if (!hit) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    this.cursor.position.copy(hit.world).addScaledVector(hit.normalWorld, worldRadius * 0.02);
    this.cursor.scale.setScalar(worldRadius);
    const up = new THREE.Vector3(0, 0, 1);
    this.cursor.quaternion.setFromUnitVectors(up, hit.normalWorld);
  }

  hideCursor() { this.cursor.visible = false; }

  /* ── Служебное ───────────────────────────────────────────────── */

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this._updateOrthoFrustum();
  }

  _tick() {
    this._selTime.value = (performance.now() / 400) % 1000;
    this.controls.update();
    this._syncPivotMarker();
    this.renderer.render(this.scene, this.camera);
    if (this.afterRender) this.afterRender();
  }
}

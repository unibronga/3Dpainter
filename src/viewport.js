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
import { buildMeshCache, measureUVOverlap, OVERLAP_LIMIT } from './mesh-cache.js';
import { uvVerdict, buildUV } from './unwrap.js';

/**
 * Цвета материалов меша — диапазонами треугольников.
 *
 * Группы геометрии заданы в вершинах, поэтому границы делятся на три. Групп
 * может не быть вовсе: тогда весь меш — один материал.
 *
 * @returns {Array<{from:number, to:number, rgb:number[]}>}
 */
/**
 * Картинка текстуры и её ориентация. Повторённую или сдвинутую (плитка
 * кирпича по стене) не берём: одна картинка на всю развёртку — только тогда
 * тексель карты и тексель покраски совпадают.
 */
function картаИз(tex) {
  if (!tex?.image) return null;
  const плитка = tex.repeat.x !== 1 || tex.repeat.y !== 1 || tex.offset.x !== 0 || tex.offset.y !== 0;
  return плитка ? null : { image: tex.image, flipY: tex.flipY };
}

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
    // Имя материала — для ИИ: у моделей из Blender части часто уже названы.
    const имя = (mats[g.materialIndex ?? 0] || mats[0])?.name || null;
    if (to > from) out.push({ from, to, rgb, name: имя });
  }
  return out;
}
import { buildDemoMesh } from './demo.js';
import { PixelArt, Anime, makeToon, HELPER_LAYER } from './effects.js';

/** Служебное — на свой слой: эффекты вида его не трогают. */
const служебное = (o) => { o.traverse((x) => x.layers.set(HELPER_LAYER)); return o; };

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

/**
 * Аппликация на поверхности, пока её ставят: картинка проецируется с экрана
 * прямо в шейдере материала покраски. Тянешь — и она скользит по модели,
 * огибает форму и прячется за передними деталями: видеокарта рисует только
 * видимое, перекрытие выходит само. Впекается потом той же проекцией на
 * процессоре, так что легло ровно то, что было видно.
 *
 * Униформы общие на все меши: смена рамки — запись в них, без пересборки.
 */
const DECAL = {
  decalOn: { value: 0 },
  decalMap: { value: null },
  decalH: { value: new THREE.Matrix3() },
  decalView: { value: new THREE.Vector2(1, 1) },
  decalFlow: { value: 1 },
  decalFront: { value: 1 },
  decalOnlyPart: { value: 0 },
};
// Деталь, на которую ставят аппликацию, помечена атрибутом вершин
// decalPart = 1 — только на время постановки. У остальных мешей атрибута нет,
// и видеокарта отдаёт за него 0.
const DECAL_VERT = `
attribute float decalPart;
varying vec4 vDecalClip;
varying float vDecalPart;`;
const DECAL_FRAG_HEAD = `
uniform sampler2D decalMap;
uniform float decalOn, decalFlow, decalFront, decalOnlyPart;
varying float vDecalPart;
uniform mat3 decalH;
uniform vec2 decalView;
varying vec4 vDecalClip;`;
// После карты цвета и до света: аппликация освещается, как краска под ней.
const DECAL_FRAG_BODY = `
  if (decalOn > 0.5 && (decalFront < 0.5 || gl_FrontFacing) && (decalOnlyPart < 0.5 || vDecalPart > 0.5)) {
    // Точка в CSS-пикселях холста — в тех же единицах, что углы рамки.
    vec2 ndc = vDecalClip.xy / vDecalClip.w;
    vec3 hq = decalH * vec3((ndc.x * 0.5 + 0.5) * decalView.x, (0.5 - ndc.y * 0.5) * decalView.y, 1.0);
    if (hq.z > 0.0) {
      vec2 duv = hq.xy / hq.z;
      if (duv.x >= 0.0 && duv.x <= 1.0 && duv.y >= 0.0 && duv.y <= 1.0) {
        // Картинка залита с переворотом (flipY) и умноженной прозрачностью —
        // без кайм у края рисунка.
        vec4 dc = texture2D(decalMap, vec2(duv.x, 1.0 - duv.y));
        if (dc.a > 0.002) diffuseColor.rgb = mix(diffuseColor.rgb, dc.rgb / dc.a, dc.a * decalFlow);
      }
    }
  }`;

function patchSelection(material, u) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, DECAL);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + DECAL_VERT)
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vDecalClip = gl_Position;\n  vDecalPart = decalPart;');
    sh.fragmentShader = 'uniform sampler2D selMap;\nuniform float selOn;\nuniform float selTime;\n'
      + sh.fragmentShader
        .replace('#include <common>', '#include <common>' + DECAL_FRAG_HEAD)
        .replace('#include <map_fragment>', '#include <map_fragment>' + DECAL_FRAG_BODY)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
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
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Полотно вьюпорта кладём ПЕРВЫМ и помечаем классом: внутри #viewport
    // лежит ещё и полотно куба ориентации, и без явного различия под общий
    // селектор попадали оба.
    this.renderer.domElement.className = 'viewport-canvas';
    container.insertBefore(this.renderer.domElement, container.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = stageBackground();

    // Две камеры живут одновременно, переключение — подмена активной: так
    // ортография не теряет положение, набранное в перспективе.
    this.perspCamera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
    this.perspCamera.position.set(6, 5, 8);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 500);
    this.orthoCamera.position.copy(this.perspCamera.position);
    this.camera = this.perspCamera;
    this.projection = 'persp';
    // Камеры видят и модель, и служебное; эффекты вида разводят их по проходам.
    this.perspCamera.layers.enable(HELPER_LAYER);
    this.orthoCamera.layers.enable(HELPER_LAYER);
    this.pixelArt = new PixelArt();
    this.anime = new Anime();

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
    // Пока кнопка зажата (мазок, вращение, сдвиг), модель не уезжает из-под руки.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', () => { this._held = true; });
    window.addEventListener('pointerup', () => { this._held = false; });
    window.addEventListener('pointercancel', () => { this._held = false; });

    this._buildEnvironment();
    this._buildLights();
    this._buildHelpers();
    this._buildCursor();
    this._buildPivotMarker();

    // Подставка: модель стоит на ней, а не прямо в сцене. Подставка ставит
    // модель на пол в центр мира и поворачивает её «лицом» — сама модель
    // при этом не меняется, и в файл уходит в исходных координатах.
    this.stand = new THREE.Group();
    this.stand.name = '__stand';
    this.scene.add(this.stand);

    this.model = null;
    this.paintables = [];   // [{mesh, cache}]
    this.displayMode = 'material';   // material | flat | clay | normals
    this.facets = false;             // плоские грани (flatShading)
    this.spin = false;               // модель вращается сама, как на подиуме
    this._held = false;              // кнопка мыши зажата во вьюпорте — вращение ждёт
    this._lastTick = performance.now();
    // Глина и нормали — общие на все меши: в них нет карты покраски.
    this._clayMat = new THREE.MeshLambertMaterial({ color: 0xc9cdd3, side: THREE.DoubleSide });
    this._normalsMat = facingMaterial();
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
   * много отражённого света нельзя. И ещё потому, что окружение светит со
   * всех сторон: при 0.6 оно высветляло теневую сторону почти до освещённой
   * (замер: 188 против 184), и поворот солнца не читался. Оно поворачивается
   * вместе с солнцем (_placeLights).
   */
  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();
  }

  _buildLights() {
    // Один главный источник — «солнце»: у модели ясная светлая и теневая
    // сторона, на полу тень. Поворот обходит модель по кругу, и это видно.
    // Рассеянный свет снизу держит теневую сторону читаемой: краска там
    // темнее, но не уходит в черноту. Цвет без светотени — «Без света».
    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x60646c, 0.55);
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    // Подсветка с обратной стороны — слабая, без тени: только чтобы теневая
    // сторона не была плоской.
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    this.scene.add(ambient, hemi, key, fill, key.target, fill.target);
    this._key = key;
    this._fill = fill;
    this._lights = [ambient, hemi, key, fill].map((l) => ({ l, base: l.intensity }));
    this._envBase = this.scene.environmentIntensity;
    this.light = { power: 1, angle: 0 };
    // Слева спереди, ~38° над горизонтом: в начальном ракурсе (камера справа
    // спереди) одна видимая стена в свету, другая в тени, тень на полу — на
    // виду справа сзади. Свет из-за камеры делал обе стены одинаково белыми.
    this._sunDir = new THREE.Vector3(-4, 6, 6).normalize();

    // Пол, на который ложится тень. Сам пол прозрачный — видна только тень.
    this.shadowFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    this.shadowFloor.receiveShadow = true;
    служебное(this.shadowFloor);
    this.scene.add(this.shadowFloor);
  }

  /**
   * Сила (доля от обычного) и поворот солнца вокруг модели — как окошко
   * «Свет» в 3DModelist. Окружение (отражения металла) — в ту же силу.
   */
  setLight({ power = this.light.power, angle = this.light.angle } = {}) {
    this.light = { power, angle };
    for (const { l, base } of this._lights) l.intensity = base * power;
    this.scene.environmentIntensity = this._envBase * power;
    this._placeLights();
  }

  /**
   * Солнце ставится вокруг модели: направление — поворот вокруг вертикали
   * через её центр, тень считается в рамке по её размеру. Зовётся каждый
   * кадр — модель могли открыть, повернуть подставкой или сменить.
   */
  _placeLights() {
    const box = new THREE.Box3().setFromObject(this.stand);
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z) || 1;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(this.light.angle));
    const dir = this._sunDir.clone().applyQuaternion(q);
    this.scene.environmentRotation.set(0, THREE.MathUtils.degToRad(this.light.angle), 0);

    const key = this._key;
    key.target.position.copy(c);
    key.position.copy(c).addScaledVector(dir, span * 2);
    key.target.updateMatrixWorld();
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -span;
    sc.right = sc.top = span;
    sc.near = span * 0.5;
    sc.far = span * 4;
    sc.updateProjectionMatrix();

    const back = new THREE.Vector3(-dir.x, 0.35, -dir.z).normalize();
    this._fill.target.position.copy(c);
    this._fill.position.copy(c).addScaledVector(back, span * 2);
    this._fill.target.updateMatrixWorld();

    const floorY = box.isEmpty() ? 0 : box.min.y;
    this.shadowFloor.position.set(c.x, floorY - span * 0.001, c.z);
    this.shadowFloor.scale.setScalar(span * 8);
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
    служебное(this.cursor);
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
    служебное(this.pivotMarker);
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
    this.stand.add(object3D);
    this.setPose(null);        // на пол и в центр; поворот — как в файле

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
      // Готовая покраска из файла — карта цвета и карта материала. Берётся,
      // только если развёртка своя, из файла: к построенной заново старая
      // картинка не подходит, она легла бы кашей.
      const сКартой = (Array.isArray(o.material) ? o.material : [o.material]).find((m) => m?.map?.image);
      if (сКартой) {
        if (verdict.ok) {
          o.userData.sourceMaps = {
            color: картаИз(сКартой.map),
            orm: сКартой.roughnessMap?.image ? картаИз(сКартой.roughnessMap) : null,
          };
        } else {
          report.mapsDropped = (report.mapsDropped || 0) + 1;
        }
      }
      // Цвета материалов из файла — пока материал не подменён нашим. Кладём
      // их диапазонами треугольников: дальше из них выпекается первый слой.
      if (object3D.userData.materialsFromFile) {
        o.userData.sourceGroups = sourceGroups(o, cache.triCount);
      }
      o.castShadow = true;   // тень на пол; на саму модель тень не ложится — краска не темнеет пятнами
      this.paintables.push({ mesh: o, cache });
      report.meshes += 1;
      report.tris += cache.triCount;
    });

    this.frameModel();
    if (this.verticesVisible) this.setVerticesVisible(true);

    // Наложения меряем после кадрирования: порог берём от габарита модели.
    const tol = this._overlapTol();
    for (const { mesh, cache } of this.paintables) {
      const ov = measureUVOverlap(cache, tol);
      cache.overlap = ov.ratio;
      if (ov.ratio > OVERLAP_LIMIT) report.overlapping.push({ name: mesh.name || t('model.unnamed'), ratio: ov.ratio });
    }

    return report;
  }

  /** Порог наложения: на сколько метров грани должны разойтись — от габарита модели. */
  _overlapTol() { return Math.max(0.01, (this.modelSize || 1) * 0.02); }

  /**
   * Построить мешу свою развёртку вместо файловой — когда в файле она с
   * наложением. Треугольники и их порядок остаются прежними, меняются только
   * UV: по этому покраска потом и переносится (`remapLayer`).
   *
   * Старую геометрию не освобождаем — её может делить другой меш.
   *
   * @returns {{from:object, to:object, islands:number}|null} старый и новый кэш
   */
  rebuildUV(mesh) {
    const entry = this.paintables.find((p) => p.mesh === mesh);
    if (!entry) return null;
    const from = entry.cache;
    const built = buildUV(mesh.geometry);
    const to = buildMeshCache(built.geometry);
    if (!to || to.triCount !== from.triCount) return null;

    mesh.geometry = built.geometry;
    mesh.userData.paintCache = to;
    entry.cache = to;
    to.overlap = measureUVOverlap(to, this._overlapTol()).ratio;
    // Детали для ИИ считались и по островам старой развёртки.
    delete mesh.userData.mcpParts;

    // Рёбра и вершины поверх модели собраны по прежней геометрии.
    const ov = mesh.userData.meshOverlay;
    if (ov) {
      mesh.remove(ov);
      ov.traverse((o) => { if (o.isLineSegments) o.geometry.dispose(); o.material?.dispose?.(); });
      mesh.userData.meshOverlay = null;
      if (this.verticesVisible) this.setVerticesVisible(true);
    }
    return { from, to, islands: built.islands };
  }

  clearModel() {
    if (!this.model) return;
    this.stand.remove(this.model);
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
    return служебное(g);
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
        служебное(ov);
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
  /**
   * Камера снимка: копия текущей с пропорциями W × H. Если они отличаются
   * от вьюпорта, кадр шире или выше, но центр и масштаб по высоте те же.
   * Одна на снимок и на «точку на снимке» у ИИ — иначе пиксель, который он
   * видел, указывал бы мимо.
   */
  snapshotCamera(W, H) {
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
    cam.updateMatrixWorld(true);
    return cam;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.overlay] оставить каркас меша (рёбра и вершины) —
   *   ИИ смотрит на снимок по треугольникам; человеку в «Виде в PNG» он не нужен
   */
  renderView(W, H, ss = 1, opts = {}) {
    const r = this.renderer;
    const w = W * ss, h = H * ss;

    const cam = this.snapshotCamera(W, H);

    const спрятано = [];
    const спрятать = (o) => { if (o && o.visible) { o.visible = false; спрятано.push(o); } };
    спрятать(this.grid);
    спрятать(this.cursor);
    спрятать(this.pivotMarker);
    спрятать(this.shadowFloor);
    const безВыделения = [];
    for (const { mesh } of this.paintables) {
      if (!opts.overlay) спрятать(mesh.userData.meshOverlay);
      const u = mesh.userData.selUniforms;
      if (u && u.selOn.value) { u.selOn.value = 0; безВыделения.push(u); }
    }
    const фон = this.scene.background;
    const цветОчистки = r.getClearColor(new THREE.Color());
    const альфаОчистки = r.getClearAlpha();

    // С пиксель-артом снимок — та же картинка, что на экране: столько же
    // пикселей картинки по высоте кадра, без суперсэмплинга (он размыл бы
    // края квадратов). У аниме суперсэмплинг остаётся — он сглаживает линию.
    // Шейдеры эффектов сами отдают цвет в sRGB, поэтому их цель без
    // цветового пространства — байты уходят как есть.
    const аниме = this.anime.enabled;
    const пиксели = this.pixelArt.enabled && !аниме;
    const rt = пиксели
      ? new THREE.WebGLRenderTarget(W, H)
      : аниме
        ? new THREE.WebGLRenderTarget(w, h)
        : new THREE.WebGLRenderTarget(w, h, { samples: Math.min(4, r.capabilities.maxSamples || 4) });
    if (!пиксели && !аниме) rt.texture.colorSpace = THREE.SRGBColorSpace;
    const bw = пиксели ? W : w, bh = пиксели ? H : h;
    const buf = new Uint8Array(bw * bh * 4);
    try {
      this.scene.background = null;
      if (аниме) {
        const экран = this.container.clientHeight || H;
        this.anime.render(r, this.scene, cam, {
          width: w, height: h, scale: h / экран,
          meshes: this.paintables.map((p) => p.mesh),
          target: rt, transparent: true, helpers: false,
        });
      } else if (пиксели) {
        const экран = this.container.clientHeight || H;
        this.pixelArt.render(r, this.scene, cam, {
          width: W, height: H, px: this.pixelArt.size * (H / экран),
          target: rt, transparent: true, helpers: false,
        });
      } else {
        r.setRenderTarget(rt);
        r.setClearColor(0x000000, 0);
        r.clear();
        r.render(this.scene, cam);
      }
      r.readRenderTargetPixels(rt, 0, 0, bw, bh, buf);
    } finally {
      r.setRenderTarget(null);
      r.setClearColor(цветОчистки, альфаОчистки);
      this.scene.background = фон;
      спрятано.forEach((o) => { o.visible = true; });
      безВыделения.forEach((u) => { u.selOn.value = 1; });
      rt.dispose();
    }
    return shrinkPremultiplied(buf, bw, bh, пиксели ? 1 : ss);
  }

  /** Ракурс камеры — для проекта: открыл и смотришь туда же, куда смотрел. */
  viewState() {
    const c = this.camera;
    return {
      projection: this.projection,
      position: c.position.toArray(), up: c.up.toArray(),
      target: this.controls.target.toArray(),
      zoom: c.zoom, orthoHeight: this._orthoHeight || null,
    };
  }

  setViewState(v) {
    if (!v) return;
    if (v.projection && v.projection !== this.projection) this.setProjection(v.projection);
    const c = this.camera;
    c.position.fromArray(v.position);
    if (v.up) c.up.fromArray(v.up);
    this.controls.target.fromArray(v.target);
    if (c.isOrthographicCamera && v.orthoHeight) this._updateOrthoFrustum(v.orthoHeight);
    if (v.zoom) c.zoom = v.zoom;
    c.updateProjectionMatrix();
    c.lookAt(this.controls.target);
    this.controls.update();
  }

  /* ── Положение модели ────────────────────────────────────────── */

  /**
   * Поставить модель: повернуть подставку и опустить модель на пол, в центр.
   *
   * Где у модели верх, файл сообщает не всегда (у OBJ и STL оси как у того,
   * кто экспортировал), а где перед — никогда: этого в геометрии нет. Поэтому
   * поворот задаёт человек, а на пол и в центр модель ставится всегда —
   * иначе она наполовину уходит под сетку, а «вокруг мира» вращает мимо.
   *
   * @param {number[]|null} q кватернион [x, y, z, w]; null — как в файле
   * @returns {number[]} что стоит теперь
   */
  setPose(q) {
    const s = this.stand;
    if (q) s.quaternion.fromArray(q).normalize(); else s.quaternion.identity();
    s.position.set(0, 0, 0);
    s.updateMatrixWorld(true);
    if (this.model) {
      const box = new THREE.Box3().setFromObject(this.model);
      if (!box.isEmpty()) {
        const c = box.getCenter(new THREE.Vector3());
        s.position.set(-c.x, -box.min.y, -c.z);
        s.updateMatrixWorld(true);
      }
    }
    return this.pose();
  }

  /** Текущий поворот подставки. */
  pose() { return this.stand.quaternion.toArray().map((v) => +v.toFixed(6)); }

  /** Довернуть подставку поворотом q (в мировых осях) и поставить заново. */
  _turnStand(q) {
    return this.setPose(q.multiply(this.stand.quaternion).toArray());
  }

  /**
   * «Это перед»: модель смотрит на камеру — развернуть её так, чтобы этот
   * бок встал к виду «Спереди». Поворот только вокруг вертикали: верх не
   * трогаем, даже если камера смотрела сверху.
   */
  poseFrontFromCamera() {
    const d = this.camera.position.clone().sub(this.controls.target);
    const угол = Math.atan2(d.x, d.z);             // 0 — камера на виде «спереди»
    return this._turnStand(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -угол));
  }

  /** «Это верх»: то, что обращено к камере, повернуть вверх. */
  poseUpFromCamera() {
    const d = this.camera.position.clone().sub(this.controls.target).normalize();
    return this._turnStand(new THREE.Quaternion().setFromUnitVectors(d, new THREE.Vector3(0, 1, 0)));
  }

  /** Повернуть модель вокруг вертикали на deg градусов. */
  poseTurn(deg) {
    return this._turnStand(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180));
  }

  /**
   * Сделать что-то с моделью в её исходных координатах — для выдачи в файл.
   * GLTFExporter пишет собственное положение узла, а OBJExporter берёт
   * мировую матрицу: без этого поворот подставки уехал бы в OBJ.
   */
  async inFileSpace(дело) {
    const s = this.stand;
    const q = s.quaternion.clone(), p = s.position.clone();
    s.quaternion.identity(); s.position.set(0, 0, 0);
    s.updateMatrixWorld(true);
    try { return await дело(); } finally {
      s.quaternion.copy(q); s.position.copy(p);
      s.updateMatrixWorld(true);
    }
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
    // Материал аниме живёт рядом и ставится на меш только на время кадра
    // с эффектом: пунктир выделения на нём тот же.
    const toon = new THREE.MeshBasicMaterial({ map: texture });
    patchSelection(toon, u);
    mesh.userData.toonMaterial = makeToon(toon, this.anime.uniforms);
    // Двусторонняя отрисовка: у моделей с настоящими дырами в одежде
    // (разрыв рубашки, звезда на куртке) сквозь отверстие иначе виден фон —
    // прореха в пустоту. С изнанкой дыра читается как дыра в ткани. Изнанка
    // того же цвета, что и лицо: тексели у треугольника одни на обе стороны.
    for (const m of [mesh.userData.matMaterial, mesh.userData.flatMaterial, toon]) m.side = THREE.DoubleSide;
    mesh.userData.matMaterial.flatShading = this.facets;
    mesh.material = this._materialFor(mesh);
    if (old && old !== mesh.material && old !== this._clayMat && old !== this._normalsMat) {
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

      for (const m of [mat, mesh.userData.flatMaterial, mesh.userData.toonMaterial]) {
        if (!m) continue;
        m.transparent = on;
        // Изнанка видна всегда (см. applyPaintMaterial) — и сквозь стекло тоже.
        m.needsUpdate = true;
      }
    }
  }

  /** @param {'material'|'flat'|'clay'|'normals'} mode */
  setDisplayMode(mode) {
    this.displayMode = mode;
    for (const { mesh } of this.paintables) {
      const m = this._materialFor(mesh);
      if (m) mesh.material = m;
    }
  }

  _materialFor(mesh) {
    const mode = this.displayMode;
    if (mode === 'clay') return this._clayMat;
    if (mode === 'normals') return this._normalsMat;
    return mode === 'flat' ? mesh.userData.flatMaterial : mesh.userData.matMaterial;
  }

  /** Плоские грани, как в low-poly; выключено — нормали из файла. */
  setFacets(on) {
    this.facets = on;
    const mats = [this._clayMat, this._normalsMat, ...this.paintables.map((p) => p.mesh.userData.matMaterial)];
    for (const m of mats) {
      if (!m || m.flatShading === on) continue;
      m.flatShading = on;
      m.needsUpdate = true;
    }
  }

  /** Модель вращается сама вокруг вертикали — пока не взялись за мышь. */
  setSpin(on) { this.spin = on; }

  _spinStep(dt) {
    if (!this.model || this._held) return;
    const box = new THREE.Box3().setFromObject(this.stand);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), SPIN_SPEED * dt);
    const rot = (v) => { v.x -= c.x; v.z -= c.z; v.applyQuaternion(q); v.x += c.x; v.z += c.z; };
    rot(this.camera.position);
    rot(this.controls.target);
    this.camera.lookAt(this.controls.target);
  }

  /* ── Аппликация на поверхности ───────────────────────────────── */

  /**
   * Показать картинку аппликации на модели.
   * @param {object|null} img картинка из decal.js; null — убрать
   * @param {number[]} inv обратная матрица рамки (quadInverse), построчно
   */
  setDecalPreview(img, inv, { flow = 1, frontOnly = true, part = null } = {}) {
    this._markDecalPart(part);
    if (!img) { DECAL.decalOn.value = 0; return; }
    if (this._decalSrc !== img.canvas) {
      DECAL.decalMap.value?.dispose();
      const tex = new THREE.CanvasTexture(img.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.premultiplyAlpha = true;
      tex.anisotropy = 4;
      DECAL.decalMap.value = tex;
      this._decalSrc = img.canvas;
    }
    const c = this.renderer.domElement;
    DECAL.decalView.value.set(c.clientWidth, c.clientHeight);
    DECAL.decalH.value.set(...inv);
    DECAL.decalFlow.value = flow;
    DECAL.decalFront.value = frontOnly ? 1 : 0;
    DECAL.decalOnlyPart.value = part ? 1 : 0;
    DECAL.decalOn.value = 1;
  }

  /**
   * Пометить вершины детали атрибутом decalPart. Атрибут временный: он
   * живёт, только пока аппликацию ставят, и снимается с прежней детали —
   * иначе уехал бы в выгрузку вместе с геометрией.
   * @param {{mesh, tris: Uint8Array}|null} part
   */
  _markDecalPart(part) {
    const was = this._decalPart;
    if (was && (!part || was.mesh !== part.mesh || was.tris !== part.tris)) {
      was.mesh.geometry.deleteAttribute('decalPart');
      this._decalPart = null;
    }
    if (!part || this._decalPart) return;
    const geo = part.mesh.geometry;
    const idx = part.mesh.userData.paintCache.idx;
    const flag = new Float32Array(geo.getAttribute('position').count);
    for (let t = 0; t < part.tris.length; t++) {
      if (!part.tris[t]) continue;
      flag[idx[t * 3]] = 1; flag[idx[t * 3 + 1]] = 1; flag[idx[t * 3 + 2]] = 1;
    }
    geo.setAttribute('decalPart', new THREE.BufferAttribute(flag, 1));
    this._decalPart = part;
  }

  /* ── Глубина с экрана ────────────────────────────────────────── */

  /**
   * Снимок того, что видно с экрана: для каждого пикселя — расстояние вдоль
   * взгляда до ближайшей поверхности модели. По нему фигуры, текст и
   * аппликация печатаются только на видимое, а не сквозь руку на грудь.
   *
   * Одна отрисовка модели в float-цель вдвое мельче CSS-пикселей холста:
   * на внутреннем силуэте (край лацкана над рубашкой) спорная полоса —
   * в клетку снимка, и мельче клетка — уже полоса. Пол, сетка, рёбра и
   * курсор в снимок не попадают. Без float-целей (старая видеокарта) — null,
   * и печать идёт как раньше, сквозь.
   *
   * @param {{mesh, tris: Uint8Array}|null} [only] снять одну деталь: она тогда
   *   загораживает только сама себя — волосы над лицом аппликацию на лицо
   *   не перехватывают
   * @returns {null|{data: Float32Array, w, h, k, tol, pxAt(z), mvFor(mesh)}}
   *   data — сверху вниз, клеток w×h; k — клеток на CSS-пиксель;
   *   mvFor(mesh) — элементы матрицы «меш → вид»
   */
  depthSnapshot(only = null) {
    if (!this.model || !this.renderer.extensions.has('EXT_color_buffer_float')) return null;
    const canvas = this.renderer.domElement;
    const k = 2;
    const w = (canvas.clientWidth | 0) * k, h = (canvas.clientHeight | 0) * k;
    if (w < 2 || h < 2) return null;

    const cam = this.camera;
    cam.updateMatrixWorld();
    this.model.updateMatrixWorld(true);

    if (!this._depthMat) {
      // Расстояние вдоль взгляда, линейное: у перспективы буфер глубины
      // нелинеен, и допуск в метрах по нему не задать.
      this._depthMat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        vertexShader: 'varying float vZ; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }',
      });
    }
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthBuffer: true });

    // Рисуем одну модель, без всего остального сцены: меняем материалы на
    // время и прячем рёбра поверх.
    const swapped = [];
    if (!only) this.model.traverse((o) => {
      if (o.isMesh && this.paintables.some((p) => p.mesh === o)) { swapped.push([o, o.material]); o.material = this._depthMat; }
      else if (o.isLine || o.isLineSegments || o.isPoints) { swapped.push([o, null, o.visible]); o.visible = false; }
    });
    const prevTarget = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    const parent = only ? null : this.model.parent;
    const scene = new THREE.Scene();
    // Модель переезжает в пустую сцену на одну отрисовку — мировые матрицы
    // уже посчитаны и с подставкой, поэтому обновление их не трогает.
    scene.matrixWorldAutoUpdate = false;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrixWorldAutoUpdate = false;
    if (parent) holder.matrixWorld.copy(parent.matrixWorld);
    scene.add(holder);
    let part = null;
    if (only) {
      // Одна деталь — своей геометрией из её треугольников, на месте меша.
      const { pos, idx } = only.mesh.userData.paintCache;
      let n = 0;
      for (let t = 0; t < only.tris.length; t++) if (only.tris[t]) n++;
      const p = new Float32Array(n * 9);
      let o = 0;
      for (let t = 0; t < only.tris.length; t++) {
        if (!only.tris[t]) continue;
        for (let c = 0; c < 3; c++) { const v = idx[t * 3 + c] * 3; p[o++] = pos[v]; p[o++] = pos[v + 1]; p[o++] = pos[v + 2]; }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      part = new THREE.Mesh(g, this._depthMat);
      part.matrixAutoUpdate = false;
      part.matrixWorldAutoUpdate = false;
      part.matrixWorld.copy(only.mesh.matrixWorld);
      scene.add(part);
    } else {
      parent?.remove(this.model);
      holder.add(this.model);
    }

    let px = null;
    try {
      this.renderer.setRenderTarget(rt);
      // Дальше дальнего: фон — «ничего не видно».
      this.renderer.setClearColor(new THREE.Color(1e9, 0, 0), 1);
      this.renderer.clear();
      this.renderer.render(scene, cam);
      px = new Float32Array(w * h * 4);
      this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    } finally {
      if (part) part.geometry.dispose();
      else { holder.remove(this.model); parent?.add(this.model); }
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(prevClear, prevAlpha);
      for (const [o, mat, vis] of swapped) { if (mat) o.material = mat; else o.visible = vis; }
      rt.dispose();
    }

    // Чтение идёт снизу вверх — переворачиваем в порядок экрана.
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      for (let x = 0; x < w; x++) data[y * w + x] = px[src + x * 4];
    }

    // Пиксель экрана в метрах на глубине z: им растёт допуск у граней,
    // которые идут к взгляду вкось.
    const pxAt = cam.isOrthographicCamera
      ? (() => { const m = (cam.top - cam.bottom) / cam.zoom / (h / k); return () => m; })()
      : (() => { const m = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (h / k); return (z) => z * m; })();
    const mv = new THREE.Matrix4();
    return {
      data, w, h, k, pxAt,
      // Постоянная часть допуска — доля размера модели: накладка в 2–3 см от
      // стены ещё отделяется, а неточность растеризации — нет.
      tol: (this.modelSize || 1) * 0.002,
      mvFor: (mesh) => mv.multiplyMatrices(cam.matrixWorldInverse, mesh.matrixWorld).elements.slice(),
    };
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
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._lastTick) / 1000);
    this._lastTick = now;
    if (this.spin) this._spinStep(dt);
    this._placeLights();
    this._selTime.value = (performance.now() / 400) % 1000;
    this.controls.update();
    this._syncPivotMarker();
    if (this.anime.enabled) {
      const c = this.renderer.domElement;
      this.anime.render(this.renderer, this.scene, this.camera, {
        width: c.width, height: c.height, scale: this.renderer.getPixelRatio(),
        meshes: this.paintables.map((p) => p.mesh), target: null,
      });
    } else if (this.pixelArt.enabled) {
      const c = this.renderer.domElement;
      this.pixelArt.render(this.renderer, this.scene, this.camera, {
        width: c.width, height: c.height,
        px: this.pixelArt.size * this.renderer.getPixelRatio(),
        target: null,
      });
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    if (this.afterRender) this.afterRender();
  }
}

/** Скорость вращения «на подиуме», радиан в секунду: оборот за ~30 с. */
const SPIN_SPEED = (2 * Math.PI) / 30;

/**
 * Фон сцены — пятно света сверху к тёмным краям, как сцена 3DModelist
 * (#2f3841 → #1a2027). Текстура фона растягивается на кадр целиком.
 */
function stageBackground() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 205, 0, 256, 205, 400);
  grad.addColorStop(0, '#2f3841');
  grad.addColorStop(1, '#1a2027');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Нормали: лицевые грани синие, вывернутые — красные (Face Orientation в
 * Blender), поверх светотени глины.
 */
function facingMaterial() {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n  gl_FragColor.rgb *= gl_FrontFacing ? vec3(0.42, 0.58, 1.0) : vec3(1.0, 0.36, 0.36);');
  };
  return m;
}

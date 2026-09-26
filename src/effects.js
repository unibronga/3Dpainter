/**
 * Эффекты вида. Меняют только то, КАК модель показана во вьюпорте и в
 * «Виде в PNG», — покраска, карты и файлы остаются прежними.
 *
 * Первый эффект — пиксель-арт. Сцена рисуется в маленькую цель, где один
 * её тексель — один «пиксель» картинки, и растягивается на экран ровными
 * квадратами без сглаживания. Сверху — урезание цветов и тёмный контур по
 * силуэту, как рисуют пиксель-арт руками.
 *
 * Второй — аниме (cel-shading, как в Genshin Impact): свет ступенями с
 * резкой границей тени, чернильная линия по силуэту и сгибам, светлая
 * кромка по краю. Свет считает свой материал меша, линию — растяжка по
 * нормалям и глубине.
 *
 * 🔴 Служебное (сетка, кольцо кисти, точка вращения, каркас) рисуется
 * вторым проходом в полном разрешении: кольцо кисти, размазанное в крупные
 * квадраты, перестаёт показывать, куда ляжет мазок. Чтобы сетка при этом
 * пряталась за моделью, растяжка пишет в буфер глубины глубину маленькой
 * цели — служебное проверяется о ту же модель, что видна на экране.
 */

import * as THREE from 'three';

/** Слой служебных объектов: их не пикселизуем. */
export const HELPER_LAYER = 1;

/** Предел уровней цвета на канал; на пределе урезания нет. */
export const LEVELS_OFF = 17;

const VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/*
 * Растяжка маленькой цели на вывод. Комментарии — снаружи: в тексте шейдера
 * держим только ASCII, иначе строгий компилятор GLSL его не примет.
 *   uPx          — пикселей вывода на пиксель картинки
 *   uLow         — размер маленькой цели
 *   uLevels      — уровней на канал, 0 — без урезания
 *   uBg          — фон, линейный
 *   uTransparent — фон прозрачный (снимок в PNG): цвет отдаём «умноженным на
 *                  покрытие», как обычный рендер
 * Контур: пустой пиксель рядом с моделью берёт затемнённый цвет ближайшего
 * соседа и его глубину — сетка за контуром прячется так же, как за моделью.
 * Урезаются цвета модели без умножения на покрытие.
 */
const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform float uPx;
  uniform ivec2 uLow;
  uniform float uLevels;
  uniform float uOutline;
  uniform vec3 uBg;
  uniform float uTransparent;

  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  vec3 toLin(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  ivec2 inside(ivec2 p) { return clamp(p, ivec2(0), uLow - 1); }

  void main() {
    ivec2 p = ivec2(floor(gl_FragCoord.xy / uPx));
    vec4 c = texelFetch(tColor, inside(p), 0);
    float d = texelFetch(tDepth, inside(p), 0).r;
    bool hit = c.a > 0.01;

    bool edge = false;
    if (!hit && uOutline > 0.5) {
      float nearest = 2.0;
      ivec2 dirs[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
      for (int i = 0; i < 4; i++) {
        ivec2 q = p + dirs[i];
        if (q.x < 0 || q.y < 0 || q.x >= uLow.x || q.y >= uLow.y) continue;
        vec4 n = texelFetch(tColor, q, 0);
        float nd = texelFetch(tDepth, q, 0).r;
        if (n.a > 0.01 && nd < nearest) {
          nearest = nd;
          c = vec4(n.rgb / n.a * 0.22, 1.0);
          edge = true;
        }
      }
      if (edge) d = nearest;
    }

    float a = edge ? 1.0 : c.a;
    vec3 col = a > 0.0 ? toSRGB(c.rgb / a) : vec3(0.0);
    if (uLevels > 0.5 && (hit || edge)) {
      float k = uLevels - 1.0;
      col = floor(col * k + 0.5) / k;
    }

    if (uTransparent > 0.5) {
      gl_FragColor = vec4(toSRGB(toLin(col) * a), a);
    } else {
      gl_FragColor = vec4(toSRGB(toLin(col) * a + uBg * (1.0 - a)), 1.0);
    }
    gl_FragDepth = (hit || edge) ? d : 1.0;
  }
`;

export class PixelArt {
  constructor() {
    this.enabled = false;
    this.size = 6;          // пикселей экрана на пиксель картинки
    this.levels = LEVELS_OFF;
    this.outline = true;

    this._rt = null;
    this._mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uPx: { value: 1 },
        uLow: { value: new THREE.Vector2(1, 1) },
        uLevels: { value: 0 },
        uOutline: { value: 1 },
        uBg: { value: new THREE.Color() },
        uTransparent: { value: 0 },
      },
      // Глубину пишем всегда: тест выключать нельзя — без него видеокарта
      // не пишет в буфер глубины вовсе.
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._mat);
    this._quad.frustumCulled = false;
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Цель под размер: пересоздаём только когда размер сменился. */
  _target(w, h) {
    if (this._rt && this._rt.width === w && this._rt.height === h) return this._rt;
    if (this._rt) { this._rt.depthTexture.dispose(); this._rt.dispose(); }
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    // Линейная цель в половинной точности: 8 бит в линейном свете дали бы
    // ступеньки в тенях ещё до урезания цветов.
    this._rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depth,
    });
    return this._rt;
  }

  /**
   * Нарисовать сцену с эффектом.
   *
   * @param {THREE.WebGLRenderer} r
   * @param {THREE.Scene} scene фон сцены берётся цветом для подложки
   * @param {THREE.Camera} camera
   * @param {object} o
   * @param {number} o.width   ширина вывода в пикселях буфера
   * @param {number} o.height  высота вывода
   * @param {number} o.px      пикселей вывода на пиксель картинки
   * @param {THREE.WebGLRenderTarget|null} o.target куда; null — экран
   * @param {boolean} [o.transparent] фон прозрачный (снимок)
   * @param {boolean} [o.helpers] дорисовать служебное вторым проходом
   */
  render(r, scene, camera, { width, height, px, target, transparent = false, helpers = true }) {
    px = Math.max(1, Math.round(px));
    const lw = Math.ceil(width / px), lh = Math.ceil(height / px);
    const rt = this._target(lw, lh);

    // Маленькая цель покрывает lw·px × lh·px — чуть больше вывода. Кадр
    // растягиваем на неё смещением вида от левого нижнего угла, чтобы каждый
    // пиксель картинки был ровно px × px: при дробном растяжении квадраты
    // шли бы через один то px, то px+1, и картинка рябила.
    const fullW = lw * px, fullH = lh * px;
    const былоСмещение = camera.view && camera.view.enabled ? { ...camera.view } : null;
    camera.setViewOffset(width, height, 0, height - fullH, fullW, fullH);

    const фон = scene.background;
    const цветОчистки = r.getClearColor(new THREE.Color());
    const альфаОчистки = r.getClearAlpha();
    const слои = camera.layers.mask;
    const autoClear = r.autoClear;
    try {
      // Проход 1: модель без служебного, на прозрачном — пустота нужна контуру.
      camera.layers.set(0);
      scene.background = null;
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(scene, camera);

      // Растяжка на вывод.
      if (былоСмещение) {
        camera.setViewOffset(былоСмещение.fullWidth, былоСмещение.fullHeight,
          былоСмещение.offsetX, былоСмещение.offsetY, былоСмещение.width, былоСмещение.height);
      } else {
        camera.clearViewOffset();
      }
      const u = this._mat.uniforms;
      u.tColor.value = rt.texture;
      u.tDepth.value = rt.depthTexture;
      u.uPx.value = px;
      u.uLow.value.set(lw, lh);
      u.uLevels.value = this.levels >= LEVELS_OFF ? 0 : this.levels;
      u.uOutline.value = this.outline ? 1 : 0;
      u.uTransparent.value = transparent ? 1 : 0;
      if (фон && фон.isColor) u.uBg.value.copy(фон); else u.uBg.value.setRGB(0, 0, 0);

      r.setRenderTarget(target);
      r.clear();
      r.render(this._quadScene, this._quadCam);

      // Проход 2: служебное поверх, в полном разрешении.
      if (helpers) {
        camera.layers.set(HELPER_LAYER);
        r.autoClear = false;
        r.render(scene, camera);
      }
    } finally {
      r.autoClear = autoClear;
      camera.layers.mask = слои;
      if (былоСмещение) {
        camera.setViewOffset(былоСмещение.fullWidth, былоСмещение.fullHeight,
          былоСмещение.offsetX, былоСмещение.offsetY, былоСмещение.width, былоСмещение.height);
      } else {
        camera.clearViewOffset();
      }
      scene.background = фон;
      r.setClearColor(цветОчистки, альфаОчистки);
      r.setRenderTarget(null);
    }
  }
}

/* ── Аниме ─────────────────────────────────────────────────────── */

/*
 * Свет аниме — в материале меша. Основа — MeshBasicMaterial: у него есть
 * карта покраски с альфой и те же куски шейдера, за которые цепляется
 * пунктир выделения, но нет своего освещения — его и подставляем.
 *
 * Свет привязан к камере (сверху слева спереди): как ни поверни модель,
 * освещённая сторона одна и та же, и стиль не разваливается в контровом
 * свете. Полуламберт делится на ступени с узкой сглаженной границей —
 * резкая тень без лесенки. Тень не серая, а прохладная: в аниме её красят
 * отдельным оттенком, а не затемнением. Кромка света — в растяжке, не здесь.
 *
 * Текст шейдера — только ASCII.
 */
const TOON_VERT_HEAD = /* glsl */`
varying vec3 vToonN;
`;
const TOON_VERT_BODY = /* glsl */`
vToonN = normalize(normalMatrix * normal);
`;
const TOON_FRAG_HEAD = /* glsl */`
varying vec3 vToonN;
uniform float toonSteps;
uniform vec3 toonLight;
uniform vec3 toonShadow;
`;
const TOON_FRAG_BODY = /* glsl */`
{
  vec3 N = normalize(vToonN);
  if (!gl_FrontFacing) N = -N;
  float t = dot(N, toonLight) * 0.5 + 0.5;
  float w = max(fwidth(t), 1e-3);
  float lit = 0.0;
  for (int i = 1; i < 4; i++) {
    if (float(i) >= toonSteps) break;
    float th = float(i) / toonSteps;
    lit += smoothstep(th - w, th + w, t);
  }
  lit /= max(toonSteps - 1.0, 1.0);
  vec3 albedo = diffuseColor.rgb;
  vec3 toonCol = albedo * mix(toonShadow, vec3(1.0), lit);
  outgoingLight = toonCol;
}
`;

/**
 * Материал аниме для меша. Встаёт в цепочку к уже навешенной правке
 * шейдера (пунктир выделения), а не вместо неё.
 *
 * @param {THREE.MeshBasicMaterial} material с картой покраски
 * @param {object} uniforms общие для всех мешей — из `Anime.uniforms`
 */
export function makeToon(material, uniforms) {
  const прежняя = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + TOON_VERT_HEAD)
      .replace('#include <project_vertex>', '#include <project_vertex>' + TOON_VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + TOON_FRAG_HEAD)
      .replace('#include <opaque_fragment>', TOON_FRAG_BODY + '#include <opaque_fragment>');
    if (прежняя) прежняя(sh, r);
  };
  material.customProgramCacheKey = () => 'paint-toon';
  return material;
}

/*
 * Растяжка аниме: цвет из прохода с материалами аниме, линия — по нормалям
 * и глубине отдельного прохода. Линия ложится там, где
 *   - кончается модель (силуэт),
 *   - одна часть модели проходит перед другой (скачок глубины),
 *   - поверхность ломается под углом (сгиб) — если сгибы включены.
 * Соседей — восемь, с диагоналями, на расстоянии толщины линии: у прямого
 * сгиба за границей оказываются сразу три, и линия выходит в полную силу, а
 * у пологой диагонали край получается полутоном и не идёт лесенкой. Одним
 * крестом из четырёх у сгиба находился один сосед — линия шла в полсилы. Глубину для служебного
 * пишем, как в пиксель-арте: сетка прячется за моделью и за линией.
 *
 * Кромка света — тоже по глубине, как в Genshin: пиксель модели светлеет,
 * если в нескольких пикселях от него по направлению нормали на экране
 * начинается фон или далёкая часть модели. Получается ровная полоса вдоль
 * силуэта. Кромка по углу к взгляду (френель) на low-poly не годится: у
 * плоской грани угол почти одинаков, и светлела бы полстены треугольником.
 */
const ANIME_FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D tColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform ivec2 uSize;
  uniform float uLine;
  uniform float uCrease;
  uniform float uNear;
  uniform float uFar;
  uniform float uOrtho;
  uniform vec3 uInk;
  uniform float uRim;
  uniform float uRimWidth;
  uniform vec3 uBg;
  uniform float uTransparent;

  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float viewZ(float d) {
    if (uOrtho > 0.5) return uNear + d * (uFar - uNear);
    return uNear * uFar / (uFar - d * (uFar - uNear));
  }
  ivec2 inside(ivec2 p) { return clamp(p, ivec2(0), uSize - 1); }

  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 c = texelFetch(tColor, inside(p), 0);
    float d = texelFetch(tDepth, inside(p), 0).r;
    vec3 n = texelFetch(tNormal, inside(p), 0).rgb * 2.0 - 1.0;
    bool hit = d < 1.0;
    float z = viewZ(d);

    float ink = 0.0;
    float nearest = d;
    if (uLine > 0.0) {
      int r = int(uLine + 0.5);
      ivec2 dirs[8] = ivec2[8](ivec2(r, 0), ivec2(-r, 0), ivec2(0, r), ivec2(0, -r),
                               ivec2(r, r), ivec2(-r, r), ivec2(r, -r), ivec2(-r, -r));
      for (int i = 0; i < 8; i++) {
        ivec2 q = inside(p + dirs[i]);
        float dq = texelFetch(tDepth, q, 0).r;
        bool hq = dq < 1.0;
        bool edge = false;
        if (hit != hq) {
          edge = true;
        } else if (hit) {
          float zq = viewZ(dq);
          if (abs(zq - z) / min(z, zq) > 0.04) edge = true;
          else if (uCrease > 0.5) {
            vec3 nq = texelFetch(tNormal, q, 0).rgb * 2.0 - 1.0;
            if (dot(n, nq) < 0.8) edge = true;
          }
        }
        if (edge) {
          ink += 0.5;
          if (hq) nearest = min(nearest, dq);
        }
      }
      ink = min(ink, 1.0);
    }

    if (hit && uRim > 0.0) {
      vec2 dir = n.xy;
      float len = length(dir);
      if (len > 0.2) {
        ivec2 q = inside(p + ivec2(round(dir / len * uRimWidth)));
        float dq = texelFetch(tDepth, q, 0).r;
        bool far = dq >= 1.0 || (viewZ(dq) - z) / z > 0.08;
        if (far) {
          float k = uRim * smoothstep(0.2, 0.6, len);
          c.rgb += (c.rgb * 0.6 + 0.22 * c.a) * k;
        }
      }
    }

    vec3 rgbP = c.rgb * (1.0 - ink) + uInk * ink;
    float a = c.a * (1.0 - ink) + ink;
    if (uTransparent > 0.5) {
      gl_FragColor = vec4(toSRGB(rgbP), a);
    } else {
      gl_FragColor = vec4(toSRGB(rgbP + uBg * (1.0 - a)), 1.0);
    }
    gl_FragDepth = (hit || ink > 0.0) ? min(d, nearest) : 1.0;
  }
`;

export class Anime {
  constructor() {
    this.enabled = false;
    this.steps = 2;       // ступеней света: 2 — свет и тень, 3–4 — с полутоном
    this.line = 2;        // толщина линии в точках экрана; 0 — без линии
    this.creases = true;  // линия по сгибам формы, не только по силуэту
    this.rim = 0.6;       // сила светлой кромки, 0–1

    /** Общие для материалов всех мешей. */
    this.uniforms = {
      toonSteps: { value: this.steps },
      // Сбоку сверху слева: в три четверти одна сторона в свету, другая в
      // тени. Свет из-за плеча камеры освещал всё видимое — и стиль пропадал.
      toonLight: { value: new THREE.Vector3(-0.72, 0.55, 0.42).normalize() },
      toonShadow: { value: new THREE.Color(0.52, 0.5, 0.66) },
    };

    this._color = null;
    this._normal = null;
    // Нормали — по граням, а не по вершинам: у low-poly со сглаженными
    // нормалями сгибы иначе не нашлись бы, а у ровной грани из двух
    // треугольников нормаль одна — диагональ квада линией не станет.
    this._normalMat = new THREE.MeshNormalMaterial({ flatShading: true, side: THREE.DoubleSide });

    this._mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: ANIME_FRAG,
      uniforms: {
        tColor: { value: null },
        tNormal: { value: null },
        tDepth: { value: null },
        uSize: { value: new THREE.Vector2(1, 1) },
        uLine: { value: 2 },
        uCrease: { value: 1 },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uOrtho: { value: 0 },
        // Линия не чёрная, а тёмная тёплая: так рисуют в аниме.
        uInk: { value: new THREE.Color(0.035, 0.025, 0.03) },
        uRim: { value: 0.6 },
        uRimWidth: { value: 4 },
        uBg: { value: new THREE.Color() },
        uTransparent: { value: 0 },
      },
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.AlwaysDepth,
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._mat);
    this._quad.frustumCulled = false;
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  _targets(w, h, samples) {
    if (this._color && this._color.width === w && this._color.height === h
        && this._color.samples === samples) return;
    if (this._color) this._color.dispose();
    if (this._normal) { this._normal.depthTexture.dispose(); this._normal.dispose(); }
    // Цвет — со сглаживанием края, линейный в половинной точности.
    this._color = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples });
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    this._normal = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depth,
    });
  }

  /**
   * Нарисовать сцену в стиле аниме.
   *
   * @param {THREE.WebGLRenderer} r
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {object} o
   * @param {number} o.width
   * @param {number} o.height
   * @param {number} o.scale  точек вывода на точку экрана — для толщины линии
   * @param {THREE.Mesh[]} o.meshes меши покраски: на кадр им ставится
   *   `userData.toonMaterial`
   * @param {THREE.WebGLRenderTarget|null} o.target
   * @param {boolean} [o.transparent]
   * @param {boolean} [o.helpers]
   */
  render(r, scene, camera, { width, height, scale, meshes, target, transparent = false, helpers = true }) {
    this._targets(width, height, Math.min(4, r.capabilities.maxSamples || 4));
    this.uniforms.toonSteps.value = this.steps;

    const прежние = meshes.map((m) => m.material);
    const фон = scene.background;
    const цветОчистки = r.getClearColor(new THREE.Color());
    const альфаОчистки = r.getClearAlpha();
    const слои = camera.layers.mask;
    const autoClear = r.autoClear;
    try {
      camera.layers.set(0);
      scene.background = null;
      r.setClearColor(0x000000, 0);

      // Проход 1: цвет в материалах аниме.
      meshes.forEach((m) => { if (m.userData.toonMaterial) m.material = m.userData.toonMaterial; });
      r.setRenderTarget(this._color);
      r.clear();
      r.render(scene, camera);

      // Проход 2: нормали и глубина — для линии.
      scene.overrideMaterial = this._normalMat;
      r.setRenderTarget(this._normal);
      r.clear();
      r.render(scene, camera);
      scene.overrideMaterial = null;
      meshes.forEach((m, i) => { m.material = прежние[i]; });

      const u = this._mat.uniforms;
      u.tColor.value = this._color.texture;
      u.tNormal.value = this._normal.texture;
      u.tDepth.value = this._normal.depthTexture;
      u.uSize.value.set(width, height);
      u.uLine.value = this.line > 0 ? Math.max(1, this.line * scale * 0.5) : 0;
      u.uCrease.value = this.creases ? 1 : 0;
      u.uRim.value = this.rim;
      u.uRimWidth.value = Math.max(2, 4 * scale);
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
      u.uTransparent.value = transparent ? 1 : 0;
      if (фон && фон.isColor) u.uBg.value.copy(фон); else u.uBg.value.setRGB(0, 0, 0);

      r.setRenderTarget(target);
      r.clear();
      r.render(this._quadScene, this._quadCam);

      if (helpers) {
        camera.layers.set(HELPER_LAYER);
        r.autoClear = false;
        r.render(scene, camera);
      }
    } finally {
      meshes.forEach((m, i) => { m.material = прежние[i]; });
      scene.overrideMaterial = null;
      r.autoClear = autoClear;
      camera.layers.mask = слои;
      scene.background = фон;
      r.setClearColor(цветОчистки, альфаОчистки);
      r.setRenderTarget(null);
    }
  }
}

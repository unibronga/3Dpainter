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
import { buildDemoMesh } from './demo.js';

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
  async loadFile(arrayBuffer, name) {
    const { parseModel } = await import('./formats.js');
    const object = await parseModel(arrayBuffer, name);
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

    const report = { name, meshes: 0, tris: 0, noUV: [], overlapping: [] };

    object3D.traverse((o) => {
      if (!o.isMesh) return;
      const cache = buildMeshCache(o.geometry);
      if (!cache) {
        report.noUV.push(o.name || t('model.unnamed'));
        o.material = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 1 });
        return;
      }
      o.userData.paintCache = cache;
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

  /** Точка, вокруг которой вращаем и приближаем. */
  pivotPoint() {
    if (this.pivotMode === 'world') return new THREE.Vector3(0, 0, 0);
    if (this.pivotMode === 'local') return this.modelCenter();
    return this.controls.target.clone();   // «камера» — куда смотрим сейчас
  }

  /* ── Навигация вокруг точки ──────────────────────────────────── */

  _bindNavigation() {
    const el = this.renderer.domElement;
    let drag = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;          // вращение — правая кнопка
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* не беда */ }
      drag = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.orbitBy(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    });

    const stop = () => { drag = null; };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
  }

  /**
   * Довернуть вид на смещение в пикселях — вокруг текущей точки вращения.
   * Крутим связку целиком: и камеру, и точку взгляда. Если вращать только
   * камеру, она перестанет смотреть туда же, и кадр поедет.
   */
  orbitBy(dx, dy, speed = (2 * Math.PI) / 500) {
    const cam = this.camera;
    const P = this.pivotPoint();
    const target = this.controls.target;

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
    mesh.material = this.displayMode === 'flat'
      ? mesh.userData.flatMaterial
      : mesh.userData.matMaterial;
    if (old && old !== mesh.material) {
      (Array.isArray(old) ? old : [old]).forEach((m) => m && m.dispose && m.dispose());
    }
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.afterRender) this.afterRender();
  }
}

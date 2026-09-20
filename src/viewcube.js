/**
 * Куб ориентации — как в 3ds Max: показывает, с какой стороны сейчас смотрит
 * камера, и позволяет встать на нужный вид щелчком по своей грани.
 *
 * Живёт в отдельном маленьком полотне со своей сценой: подмешивать гизмо в
 * основную сцену нельзя — его пришлось бы прятать от кисти, от луча и от
 * кадрирования.
 *
 * Берёт не только грани: точка попадания разбирается по осям, поэтому щелчок
 * по ребру даёт вид под 45°, а по углу — изометрию. Всего 26 направлений от
 * одного куба.
 */

import * as THREE from 'three';
import { t, onLangChange } from './i18n.js';

const SIZE = 92;          // сторона полотна в пикселях
const EDGE = 0.34;        // от какой доли грани считаем, что задето ребро

/** Порядок граней BoxGeometry: +X, −X, +Y, −Y, +Z, −Z. */
const FACES = [
  { dir: [1, 0, 0], key: 'cube.right' },
  { dir: [-1, 0, 0], key: 'cube.left' },
  { dir: [0, 1, 0], key: 'cube.top' },
  { dir: [0, -1, 0], key: 'cube.bottom' },
  { dir: [0, 0, 1], key: 'cube.front' },
  { dir: [0, 0, -1], key: 'cube.back' },
];

function faceTexture(label) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');

  x.fillStyle = '#31353b';
  x.fillRect(0, 0, 128, 128);
  x.strokeStyle = '#4b525b';
  x.lineWidth = 7;
  x.strokeRect(3.5, 3.5, 121, 121);

  x.fillStyle = '#d8dce2';
  x.font = '600 24px -apple-system, "SF Pro Text", system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(label, 64, 66);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ViewCube {
  /**
   * @param {HTMLElement} container
   * @param {object} hooks
   *   onPick(dir)     — щелчок: встать на это направление взгляда
   *   onOrbit(dx, dy) — протяжка: довернуть камеру на смещение в пикселях
   */
  constructor(container, hooks) {
    this.hooks = hooks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(SIZE, SIZE, false);
    this.renderer.domElement.className = 'viewcube-canvas';
    this.renderer.domElement.dataset.i18nTitle = 'tip.cube';
    this.renderer.domElement.title = t('tip.cube');
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    // Ортография: куб-указатель не должен «падать» в перспективу.
    this.camera = new THREE.OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);
    this.camera.position.set(0, 0, 3);
    this.camera.lookAt(0, 0, 0);

    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(t(f.key)) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    this.scene.add(this.cube);

    // Рёбра — без них куб в ортографии читается плоским пятном.
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x8b929c }),
    );
    this.cube.add(edges);

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this.hovered = -1;
    this.drag = null;       // {x, y, moved} пока кнопка зажата

    this._bind();

    // Подписи граней нарисованы в текстурах, поэтому смена языка их
    // перерисовывает: переводом надписи на картинке не заменишь.
    onLangChange(() => this._relabel());
  }

  /** Перерисовать подписи граней под текущий язык. */
  _relabel() {
    FACES.forEach((f, i) => {
      this.materials[i].map?.dispose();
      this.materials[i].map = faceTexture(t(f.key));
      this.materials[i].needsUpdate = true;
    });
    this.renderer.domElement.title = t('tip.cube');
    this.render?.();
  }

  /** Повернуть куб так, как сейчас повёрнут мир относительно камеры. */
  sync(camera) {
    this.cube.quaternion.copy(camera.quaternion).invert();
    this.renderer.render(this.scene, this.camera);
  }

  /** Направление, соответствующее точке на кубе. */
  _dirAt(clientX, clientY) {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    this._ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    this._ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this._ndc, this.camera);

    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit) return null;

    // Точку переводим в оси куба: они совпадают с осями мира, потому что
    // поворот куба как раз и есть поворот мира.
    const p = this.cube.worldToLocal(hit.point.clone());
    const axis = (v) => (v > EDGE ? 1 : v < -EDGE ? -1 : 0);
    const dir = new THREE.Vector3(axis(p.x), axis(p.y), axis(p.z));
    if (dir.lengthSq() === 0) return null;

    return { dir: dir.normalize(), faceIndex: hit.face?.materialIndex ?? -1 };
  }

  _bind() {
    const el = this.renderer.domElement;
    const DRAG_THRESHOLD = 4; // пикселей: меньше — считаем щелчком, а не протяжкой

    const clearHover = () => {
      this.hovered = -1;
      this.materials.forEach((m) => m.color.set(0xffffff));
    };

    el.addEventListener('pointermove', (e) => {
      // Протяжка: крутим камеру, как будто взялись за куб рукой.
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!this.drag.moved) { this.drag.moved = true; clearHover(); el.style.cursor = 'grabbing'; }
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        this.hooks.onOrbit(dx, dy);
        return;
      }

      const r = this._dirAt(e.clientX, e.clientY);
      const idx = r ? r.faceIndex : -1;
      if (idx === this.hovered) return;
      this.hovered = idx;
      this.materials.forEach((m, i) => m.color.set(i === idx ? 0xe0a355 : 0xffffff));
      el.style.cursor = idx >= 0 ? 'grab' : '';
    });

    el.addEventListener('pointerleave', () => { if (!this.drag) clearHover(); });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* не беда */ }
      this.drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
    });

    const finish = (e) => {
      if (!this.drag) return;
      const moved = this.drag.moved;
      const start = { x: this.drag.startX, y: this.drag.startY };
      this.drag = null;
      el.style.cursor = '';
      // Щелчок без протяжки — встать на грань, ребро или угол.
      if (!moved) {
        const r = this._dirAt(start.x, start.y);
        if (r) this.hooks.onPick(r.dir);
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);

    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose() {
    this.materials.forEach((m) => { m.map?.dispose(); m.dispose(); });
    this.cube.geometry.dispose();
    this.renderer.dispose();
  }
}

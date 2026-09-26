/**
 * Редактор развёртки.
 *
 * Показывает текстуру активного меша вместе с сеткой UV и даёт работать прямо
 * по ней: кисть, ластик, пипетка, заливка по грани и по острову. Там, где на
 * модели грань уходит из виду или слишком мелкая, по развёртке попасть проще.
 *
 * Сам ничего не красит — отдаёт координаты в текселях наружу, покраской
 * занимается то же ядро, что и во вьюпорте.
 */

import { findTriangleAtUV } from './mesh-cache.js';

/** Инструменты, которые тянутся рамкой, а не мажут по пути. */
const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'text']);

/**
 * Инструменты, которые ведут мазок. Список разрешающий, а не запрещающий:
 * раньше мазком было всё, что не пипетка, не заливка и не фигура, — и выбор
 * объекта с инструментами вида красили кистью.
 */
const BRUSH_TOOLS = new Set(['brush', 'eraser']);

export class UVEditor {
  /**
   * @param {HTMLElement} container
   * @param {object} hooks
   *   onBegin(tx, ty, shift)   — начало мазка, координаты в текселях
   *   onMove(tx, ty)
   *   onEnd()
   *   onFill(triIndex, tx, ty) — щелчок инструментом заливки
   *   onPick(tx, ty)           — пипетка
   *   brushRadiusScreen()      — радиус кисти в пикселях экрана
   *   currentTool()
   *   lassoMode(e)             — режим выделения с учётом модификаторов
   *   onLasso(pts, mode)       — контур лассо замкнут, вершины в текселях
   *   onLassoClick(mode)       — щелчок лассо без контура: снять выделение
   */
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'uv-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.target = null;
    this.cache = null;
    this.showWire = true;
    this.view = { scale: 1, ox: 0, oy: 0 }; // пикселей на единицу UV и сдвиг
    this.cursor = null;
    this.painting = false;
    this.shaping = null;     // тянущаяся рамка фигуры или текста
    this.panning = false;
    this.zooming = null;     // протяжка инструментом зума
    this.lasso = null;       // контур лассо в работе: { pts, mode, poly, hover }
    this.selSegs = null;     // контур выделения, отрезки в текселях
    this.spaceDown = false;

    this._bindEvents();
    this._observer = new ResizeObserver(() => { this.resize(); });
    this._observer.observe(container);
    this.resize();
  }

  /** Смена модели или слоя: прежняя сетка больше не годится. */
  /** Слой сетки больше не годится — построить заново при следующей отрисовке. */
  _dropWire() { this._sheetKey = null; this._sheetPending = false; }

  setTarget(target, cache) {
    const first = !this.target || this.cache !== cache;
    // 🔴 Сетку сбрасываем только при смене меша. setTarget зовётся и по
    // другим поводам — на каждый её пересчёт уходит около секунды на
    // модели в 19 тысяч треугольников, и мазок снова шёл бы рывками.
    if (first) this._dropWire();
    this.target = target;
    this.cache = cache;
    if (first || !(this.view.scale > 1)) this.fit();
    this.draw();
  }

  setShowWire(v) { this.showWire = v; this.draw(); }

  /** Контур выделения активного меша (см. selection.outline) или null. */
  setSelectionOutline(segs) { this.selSegs = segs && segs.length ? segs : null; this.draw(); }

  /** Бросить незамкнутое лассо — при смене инструмента или по Esc. */
  cancelLasso() {
    if (!this.lasso) return false;
    this.lasso = null;
    this.draw();
    return true;
  }

  /**
   * Клавиши лассо по точкам: Enter замыкает, Esc бросает, Backspace снимает
   * последнюю точку. @returns {boolean} клавиша ушла в дело
   */
  lassoKey(key) {
    const l = this.lasso;
    if (!l || !l.poly) return false;
    if (key === 'Escape') return this.cancelLasso();
    if (key === 'Enter') { this._closeLasso(); return true; }
    if (key === 'Backspace') {
      l.pts.pop();
      if (!l.pts.length) this.lasso = null;
      this.draw();
      return true;
    }
    return false;
  }

  _closeLasso() {
    const l = this.lasso;
    this.lasso = null;
    if (l && l.pts.length >= 3) this.hooks.onLasso(l.pts, l.mode);
    this.draw();
  }

  /** Тексели → пиксели панели. */
  _toScreen(tx, ty) {
    const S = this.target.size;
    return { x: this.view.ox + (tx / S) * this.view.scale, y: this.view.oy + (ty / S) * this.view.scale };
  }

  /* ── Преобразования ──────────────────────────────────────────── */

  /** Экран → тексели. */
  toTexel(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const S = this.target ? this.target.size : 1024;
    const x = clientX - r.left, y = clientY - r.top;
    return {
      tx: ((x - this.view.ox) / this.view.scale) * S,
      ty: ((y - this.view.oy) / this.view.scale) * S,
      u: (x - this.view.ox) / this.view.scale,
      v: 1 - (y - this.view.oy) / this.view.scale,
      inside: true,
    };
  }

  /**
   * Вписать квадрат развёртки в панель.
   * @returns {boolean} удалось ли — у скрытой панели размера ещё нет
   */
  fit() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!(w > 1 && h > 1)) return false;
    const s = Math.min(w, h) * 0.88;
    this.view.scale = s;
    this.view.ox = (w - s) / 2;
    this.view.oy = (h - s) / 2;
    return true;
  }

  /* ── Отрисовка ───────────────────────────────────────────────── */

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Панель могли открыть до того, как у неё появился размер: тогда
    // вписывание посчиталось по нулю и полотно осталось пустым. Как только
    // размер есть — вписываем заново.
    if (!(this.view.scale > 1)) this.fit();

    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#15171a';
    ctx.fillRect(0, 0, w, h);
    if (!this.target) return;

    const { ox, oy, scale } = this.view;

    // Шахматка под текстурой — видно, где слой прозрачный.
    this._checker(ox, oy, scale);

    // При увеличении показываем тексели как есть, без сглаживания: инструмент
    // рисует по пикселям, и видеть надо пиксели.
    ctx.imageSmoothingEnabled = scale < this.target.size;
    ctx.drawImage(this.target.canvas, ox, oy, scale, scale);

    if (this.showWire && this.cache) this._wire(ox, oy, scale);

    this._ants(ox, oy, scale);

    ctx.strokeStyle = 'rgba(224,163,85,0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, scale, scale);

    if (this.lasso) this._lassoPath();

    // Рамка тянущейся фигуры: показывает, куда она ляжет, до того как легла.
    if (this.shaping) {
      const { a, b } = this.shaping;
      const x0 = ox + (a.tx / this.target.size) * scale;
      const y0 = oy + (a.ty / this.target.size) * scale;
      const x1 = ox + (b.tx / this.target.size) * scale;
      const y1 = oy + (b.ty / this.target.size) * scale;

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      if (this.hooks.currentTool() === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      ctx.restore();
    } else if (this.cursor && BRUSH_TOOLS.has(this.hooks.currentTool())) {
      // Круг курсора — про кисть; у фигур свой размер задаётся протяжкой,
      // а у выбора и инструментов вида краски нет вовсе.
      const r = Math.max(2, this.hooks.brushRadiusScreen());
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /**
   * Перерисовать только тот кусок полотна, что поменялся.
   *
   * 🔴 Полная отрисовка тянет `drawImage` всей текстуры со сглаживанием — на
   * 1024² это десятки миллисекунд, и на каждый кадр мазка панель съедала
   * больше времени, чем сама покраска. Здесь перерисовываются те же слои
   * (шахматка, текстура, сетка), но в границах правки.
   *
   * @param {{x0,y0,x1,y1}} rect границы в текселях
   */
  drawTexelRect(rect) {
    if (!this.target || !rect) { this.draw(); return; }
    // Пока тянется рамка или курсор, поверх куска рисовать нечего — там
    // нужна полная отрисовка, иначе останется след от прошлого кадра.
    if (this.shaping || this.lasso) { this.draw(); return; }

    const { ox, oy, scale } = this.view;
    const S = this.target.size;
    const k = scale / S;
    const ctx = this.ctx;

    // Поля по краям: край мазка сглажен, и ровно по границе остался бы шов.
    // Берём не меньше двух пикселей кадра — ниже по ним выравнивается вырез.
    const поле = Math.max(2, Math.ceil(2 / k));
    const t0x = Math.max(0, rect.x0 - поле), t0y = Math.max(0, rect.y0 - поле);
    const t1x = Math.min(S, rect.x1 + поле + 1), t1y = Math.min(S, rect.y1 + поле + 1);
    if (t1x <= t0x || t1y <= t0y) return;

    // 🔴 Кусок кадра берём по ЦЕЛЫМ пикселям. У дробного прямоугольника края
    // накрыты частично, а шахматка рисуется под текстурой и по такому краю
    // просвечивает: за мазком оставалась гребёнка тонких тёмных рамок, по
    // рамке на отпечаток (замер: 220,80,55 в полной отрисовке против
    // 102–209 здесь).
    const вx = Math.floor(ox + t0x * k);
    const вy = Math.floor(oy + t0y * k);
    const вw = Math.ceil(ox + t1x * k) - вx;
    const вh = Math.ceil(oy + t1y * k) - вy;
    if (вw <= 0 || вh <= 0) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(вx, вy, вw, вh);
    ctx.clip();

    this._checker(ox, oy, scale);
    ctx.imageSmoothingEnabled = scale < S;
    // 🔴 Источник считаем ОБРАТНЫМ преобразованием того же прямоугольника, а
    // не своими границами в текселях: тогда кусок ложится на те же пиксели,
    // что и полная отрисовка, и на стыке не остаётся шва в тексель. Выход за
    // края текстуры не страшен — drawImage подрежет и источник, и место
    // вместе, преобразование от этого не поедет.
    ctx.drawImage(this.target.canvas,
      (вx - ox) / k, (вy - oy) / k, вw / k, вh / k,
      вx, вy, вw, вh);
    if (this.showWire && this.cache) this._wire(ox, oy, scale);
    this._ants(ox, oy, scale);
    ctx.restore();
  }

  /**
   * «Бегущие муравьи» — контур выделения чёрно-белым пунктиром: виден на
   * любом цвете. Здесь пунктир стоит: панель перерисовывается по делу, а не
   * каждый кадр, и гонять её ради анимации незачем.
   */
  _ants(ox, oy, scale) {
    const segs = this.selSegs;
    if (!segs) return;
    const k = scale / this.target.size;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 4) {
      ctx.moveTo(ox + segs[i] * k, oy + segs[i + 1] * k);
      ctx.lineTo(ox + segs[i + 2] * k, oy + segs[i + 3] * k);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.restore();
  }

  /** Контур лассо, пока его ведут: линия до курсора у лассо по точкам. */
  _lassoPath() {
    const l = this.lasso;
    const ctx = this.ctx;
    const pts = l.poly && l.hover ? [...l.pts, l.hover] : l.pts;
    if (!pts.length) return;
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = this._toScreen(p.tx, p.ty);
      if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
    });
    if (!l.poly) ctx.closePath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    // Первая точка лассо по точкам — сюда щёлкают, чтобы замкнуть.
    if (l.poly) {
      const f = this._toScreen(l.pts[0].tx, l.pts[0].ty);
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.fillRect(f.x - 3, f.y - 3, 6, 6);
      ctx.strokeRect(f.x - 3.5, f.y - 3.5, 7, 7);
    }
    ctx.restore();
  }

  _checker(ox, oy, scale) {
    const ctx = this.ctx;
    const step = Math.max(6, scale / 16);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, scale, scale);
    ctx.clip();
    ctx.fillStyle = '#2a2d32';
    ctx.fillRect(ox, oy, scale, scale);
    ctx.fillStyle = '#33373d';
    for (let y = 0; y < scale; y += step) {
      for (let x = ((y / step) | 0) % 2 ? step : 0; x < scale; x += step * 2) {
        ctx.fillRect(ox + x, oy + y, step, step);
      }
    }
    ctx.restore();
  }

  /**
   * Сетка развёртки.
   *
   * 🔴 Обход всех треугольников — самая дорогая работа в панели: на сфере в
   * 19 тысяч треугольников он занимает сотни миллисекунд. Раньше он шёл на
   * каждый кадр покраски и на каждый сдвиг полотна, отчего и мазок, и
   * перетаскивание шли рывками.
   *
   * Сетка живёт в координатах самой развёртки (квадрат 0..1), поэтому
   * рисуется один раз на модель, а вид накладывается растяжением картинки —
   * это стоит доли миллисекунды. Когда увеличение перерастает разрешение
   * слоя, картинка замылилась бы, и тогда рисуем честными линиями, но только
   * те треугольники, что попали в кадр: при таком зуме их единицы.
   */
  _wire(ox, oy, scale) {
    const S = this._wireSize();
    if (scale > S) { this._wireExact(ox, oy, scale); return; }

    const готовый = this._sheetReady(S);
    if (готовый) {
      const ctx = this.ctx;
      ctx.save();
      // 🔴 Сетка рисуется вычитанием, а не белым поверх. Белая линия по
      // белому атласу даёт разницу ровно ноль — после того как промежутки
      // между островами залились цветом островов, сетка на светлой модели
      // пропала бы целиком. Вычитание видно на любом фоне: на светлом даёт
      // тёмную линию, на тёмном — светлую.
      ctx.globalCompositeOperation = 'difference';
      ctx.drawImage(готовый, ox, oy, scale, scale);
      ctx.restore();
      return;
    }

    // Слой ещё не построен. На плотной сетке это почти секунда — держать
    // ради неё открытие файла незачем: строим в ближайшем простое, панель
    // пока показывается без сетки и дорисует её сама.
    this._scheduleSheet(S);
  }

  /** Готовый слой сетки, либо null, если его ещё предстоит построить. */
  _sheetReady(S) {
    return this._sheet && this._sheetKey === `${S}|${this.cache.triCount}` ? this._sheet : null;
  }

  /** Построить слой сетки в простое и перерисовать панель. */
  _scheduleSheet(S) {
    if (this._sheetPending) return;
    this._sheetPending = true;

    const построить = () => {
      this._sheetPending = false;
      if (!this.cache || !this.target) return;
      this._wireSheet(S);
      this.draw();
    };
    // requestIdleCallback есть не везде; таймер — запасной путь.
    if (typeof requestIdleCallback === 'function') requestIdleCallback(построить, { timeout: 600 });
    else setTimeout(построить, 0);
  }

  /** Разрешение слоя сетки: по текстуре, но в разумных пределах. */
  _wireSize() {
    const s = this.target?.size || 1024;
    return Math.max(1024, Math.min(2048, s));
  }

  /** Слой сетки в координатах развёртки — строится один раз на модель. */
  _wireSheet(S) {
    if (this._sheet && this._sheetKey === `${S}|${this.cache.triCount}`) return this._sheet;

    const слой = this._sheet || document.createElement('canvas');
    слой.width = слой.height = S;
    const g = слой.getContext('2d');
    g.clearRect(0, 0, S, S);

    const { uv, idx, triCount } = this.cache;
    g.strokeStyle = 'rgba(255,255,255,0.42)';
    // Линия тоньше пикселя слоя: при растяжении в кадр она станет обычной.
    g.lineWidth = Math.max(1, S / 1024);
    g.beginPath();
    for (let t = 0; t < triCount; t++) {
      const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
      g.moveTo(uv[i0 * 2] * S, (1 - uv[i0 * 2 + 1]) * S);
      g.lineTo(uv[i1 * 2] * S, (1 - uv[i1 * 2 + 1]) * S);
      g.lineTo(uv[i2 * 2] * S, (1 - uv[i2 * 2 + 1]) * S);
      g.closePath();
    }
    g.stroke();

    this._sheet = слой;
    this._sheetKey = `${S}|${this.cache.triCount}`;
    return слой;
  }

  /** Точные линии — только для треугольников, попавших в кадр. */
  _wireExact(ox, oy, scale) {
    const ctx = this.ctx;
    const { uv, idx, triCount } = this.cache;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;

    ctx.save();
    ctx.globalCompositeOperation = 'difference';   // см. _wire: видно на любом фоне
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = 0; t < triCount; t++) {
      const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
      const x0 = ox + uv[i0 * 2] * scale, y0 = oy + (1 - uv[i0 * 2 + 1]) * scale;
      const x1 = ox + uv[i1 * 2] * scale, y1 = oy + (1 - uv[i1 * 2 + 1]) * scale;
      const x2 = ox + uv[i2 * 2] * scale, y2 = oy + (1 - uv[i2 * 2 + 1]) * scale;

      // Мимо кадра — и считать нечего.
      if (Math.max(x0, x1, x2) < 0 || Math.min(x0, x1, x2) > w) continue;
      if (Math.max(y0, y1, y2) < 0 || Math.min(y0, y1, y2) > h) continue;

      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }


  /**
   * Щелчок лассо по точкам. Первый ставит начало; щелчок по началу или
   * двойной щелчок замыкают контур.
   */
  _polyClick(e, p) {
    const now = performance.now();
    const l = this.lasso;
    if (!l) {
      this.lasso = { pts: [p], mode: this.hooks.lassoMode(e), poly: true, hover: p, at: now };
      this.draw();
      return;
    }
    const q = this._toScreen(p.tx, p.ty);
    const first = this._toScreen(l.pts[0].tx, l.pts[0].ty);
    const last = this._toScreen(l.pts[l.pts.length - 1].tx, l.pts[l.pts.length - 1].ty);
    const nearFirst = l.pts.length >= 3 && Math.hypot(q.x - first.x, q.y - first.y) <= 8;
    const dbl = now - l.at < 350 && Math.hypot(q.x - last.x, q.y - last.y) <= 5;
    if (nearFirst || dbl) { this._closeLasso(); return; }
    l.pts.push(p);
    l.at = now;
    this.draw();
  }

  /** Масштаб вокруг точки панели, а не вокруг её угла. */
  zoomAround(mx, my, k) {
    const next = Math.max(24, Math.min(40000, this.view.scale * k));
    const f = next / this.view.scale;
    this.view.ox = mx - (mx - this.view.ox) * f;
    this.view.oy = my - (my - this.view.oy) * f;
    this.view.scale = next;
    this.draw();
  }

  /* ── Ввод ────────────────────────────────────────────────────── */

  _bindEvents() {
    const cv = this.canvas;

    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      // Захват указателя — удобство, а не условие: если он не даётся,
      // работать всё равно надо.
      try { cv.setPointerCapture(e.pointerId); } catch { /* не беда */ }

      // Правая кнопка, средняя и пробел — перемещение полотна.
      if (e.button === 2 || e.button === 1 || this.spaceDown) {
        this.panning = { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button !== 0 || !this.target) return;

      const p = this.toTexel(e.clientX, e.clientY);
      const tool = this.hooks.currentTool();

      if (tool === 'eyedropper') { this.hooks.onPick(p.tx, p.ty); return; }
      if (tool.startsWith('fill')) {
        const tri = tool === 'fill-layer' ? -1 : findTriangleAtUV(this.cache, p.u, p.v);
        this.hooks.onFill(tri, p.tx, p.ty);
        this.draw();
        return;
      }
      // Фигуры и текст здесь тянутся рамкой — тем же движением, что и на
      // модели: инструмент один, значит и повадки у него должны быть одни.
      if (SHAPE_TOOLS.has(tool)) {
        this.shaping = { a: p, b: p, shift: e.shiftKey };
        this.draw();
        return;
      }
      // Сдвиг и вращение в плоскости развёртки — одно и то же: крутить
      // плоскую карту незачем, её двигают. Зум — протяжкой вверх и вниз
      // вокруг точки нажатия, как во вьюпорте.
      // Лассо: вольное ведётся, пока кнопка нажата; по точкам — щелчками.
      if (tool === 'lasso') {
        const r = cv.getBoundingClientRect();
        this.lasso = { pts: [p], mode: this.hooks.lassoMode(e), poly: false,
                       sx: e.clientX - r.left, sy: e.clientY - r.top, far: false };
        this.draw();
        return;
      }
      if (tool === 'lasso-poly') {
        this._polyClick(e, p);
        return;
      }
      if (tool === 'pan' || tool === 'orbit') {
        this.panning = { x: e.clientX, y: e.clientY };
        return;
      }
      if (tool === 'zoom') {
        const r = cv.getBoundingClientRect();
        this.zooming = { y: e.clientY, mx: e.clientX - r.left, my: e.clientY - r.top };
        return;
      }
      if (!BRUSH_TOOLS.has(tool)) return;   // выбор объекта здесь ничего не делает
      this.painting = true;
      this.hooks.onBegin(p.tx, p.ty, e.shiftKey);
    });

    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top };

      if (this.panning) {
        this.view.ox += e.clientX - this.panning.x;
        this.view.oy += e.clientY - this.panning.y;
        this.panning = { x: e.clientX, y: e.clientY };
        this.draw();
        return;
      }
      if (this.lasso) {
        const p = this.toTexel(e.clientX, e.clientY);
        const l = this.lasso;
        if (l.poly) {
          l.hover = p;
        } else {
          const last = this._toScreen(l.pts[l.pts.length - 1].tx, l.pts[l.pts.length - 1].ty);
          // Точка на каждый пиксель — лишнее: контур мельче не станет.
          if (Math.hypot(this.cursor.x - last.x, this.cursor.y - last.y) >= 2) l.pts.push(p);
          if (Math.hypot(this.cursor.x - l.sx, this.cursor.y - l.sy) > 3) l.far = true;
        }
        this.draw();
        return;
      }
      if (this.zooming) {
        const z = this.zooming;
        this.zoomAround(z.mx, z.my, Math.pow(1.01, z.y - e.clientY));
        z.y = e.clientY;
        return;
      }
      if (this.shaping) {
        this.shaping.b = this.toTexel(e.clientX, e.clientY);
        this.shaping.shift = e.shiftKey;
        this.draw();
        return;
      }
      if (this.painting) {
        const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const q of (pts.length ? pts : [e])) {
          const p = this.toTexel(q.clientX, q.clientY);
          this.hooks.onMove(p.tx, p.ty);
        }
        return;
      }
      this.draw();
    });

    const stop = () => {
      if (this.lasso && !this.lasso.poly) {
        const l = this.lasso;
        this.lasso = null;
        // Щелчок без протяжки — снять выделение, как в Photoshop.
        if (!l.far || l.pts.length < 3) this.hooks.onLassoClick(l.mode);
        else this.hooks.onLasso(l.pts, l.mode);
        this.draw();
      }
      if (this.painting) { this.painting = false; this.hooks.onEnd(); }
      if (this.shaping) {
        const { a, b, shift } = this.shaping;
        this.shaping = null;
        this.hooks.onShape(a, b, shift);
        this.draw();
      }
      this.panning = false;
      this.zooming = null;
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
    cv.addEventListener('pointerleave', () => { this.cursor = null; this.draw(); });
  }
}

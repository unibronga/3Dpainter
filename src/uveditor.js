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

    ctx.strokeStyle = 'rgba(224,163,85,0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, scale, scale);

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
    } else if (this.cursor && !SHAPE_TOOLS.has(this.hooks.currentTool())) {
      // Круг курсора — про кисть; у фигур свой размер задаётся протяжкой.
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
    if (this.shaping) { this.draw(); return; }

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


  /* ── Ввод ────────────────────────────────────────────────────── */

  _bindEvents() {
    const cv = this.canvas;

    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.max(24, Math.min(40000, this.view.scale * k));
      const f = next / this.view.scale;
      // Масштабируем вокруг курсора, а не вокруг угла панели.
      this.view.ox = mx - (mx - this.view.ox) * f;
      this.view.oy = my - (my - this.view.oy) * f;
      this.view.scale = next;
      this.draw();
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
      if (this.painting) { this.painting = false; this.hooks.onEnd(); }
      if (this.shaping) {
        const { a, b, shift } = this.shaping;
        this.shaping = null;
        this.hooks.onShape(a, b, shift);
        this.draw();
      }
      this.panning = false;
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
    cv.addEventListener('pointerleave', () => { this.cursor = null; this.draw(); });
  }
}

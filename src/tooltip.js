/**
 * Тултипы: своя карточка вместо системной подсказки — у инструментов и у
 * всех кнопок и элементов, где подсказка была.
 *
 * Системный title показывает одну серую строку, через секунду и где попало.
 * Здесь — карточка у элемента: появляется после короткой паузы, а пока рука
 * ведёт от кнопки к кнопке — сразу, без новой паузы, как в графических
 * пакетах.
 *
 * Источников два:
 *   data-tip="id" — инструменты: название, клавиша и описание дают по id;
 *   title          — всё остальное. При наведении title забирается в
 *                    data-tip-text, иначе браузер показал бы и свою
 *                    подсказку поверх нашей. Разметку переводит applyDOM(),
 *                    код ставит title сам — и то и другое снова кладёт
 *                    свежий title, поэтому при смене языка карточка
 *                    заговорит на новом.
 */

const ЗАДЕРЖКА = 380;     // мс до первого показа
const ПОДРЯД = 700;       // мс, в течение которых следующий показ — мгновенный

/**
 * Разобрать строку подсказки: «Отменить (Cmd/Ctrl+Z)» → заголовок и клавиша,
 * «Выбор объекта: щелчок делает…» → заголовок и описание.
 */
function parse(строка) {
  let title = строка.trim(), key = '', text = '';
  // Клавиша в скобках в конце — только если похожа на сочетание: латиница,
  // одиночный символ или диапазон цифр. «(0, 0, 0)» клавишей не станет.
  const m = title.match(/^(.*\S)\s*\(([^()]+)\)$/);
  if (m) {
    const внутри = m[2].trim();
    const похожа = /^[A-Za-z0-9⌘⇧⌥+\/\-–, .]+$/.test(внутри)
      && (/[A-Za-z]/.test(внутри) || внутри.length === 1 || внутри.includes('–'));
    if (похожа) { title = m[1]; key = внутри; }
  }
  const двоеточие = title.indexOf(': ');
  if (двоеточие > 0 && двоеточие <= 32) {
    text = title.slice(двоеточие + 2);
    title = title.slice(0, двоеточие);
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return { title, key, text };
}

/**
 * @param {(id: string) => {title: string, key?: string, text?: string}} resolveTool
 *        содержимое для элементов с data-tip
 */
export function initTooltips(resolveTool) {
  const карта = document.createElement('div');
  карта.className = 'tip-card';
  карта.setAttribute('role', 'tooltip');
  document.body.appendChild(карта);

  let таймер = 0;
  let скрытоВ = 0;
  let текущий = null;
  let ждёт = null;         // элемент, чей показ отложен таймером

  const спрятать = () => {
    clearTimeout(таймер);
    ждёт = null;
    if (текущий) скрытоВ = performance.now();
    текущий = null;
    карта.classList.remove('on');
  };

  /** Что показать для элемента, или null, если нечего. */
  const содержимое = (узел) => {
    if (узел.dataset.tip) return resolveTool(узел.dataset.tip);
    const строка = узел.dataset.tipText;
    return строка ? parse(строка) : null;
  };

  const показать = (узел) => {
    const что = содержимое(узел);
    if (!что || !что.title) return;
    карта.replaceChildren();
    const шапка = document.createElement('div');
    шапка.className = 'tip-head';
    const имя = document.createElement('span');
    имя.className = 'tip-title';
    имя.textContent = что.title;
    шапка.appendChild(имя);
    if (что.key) {
      const клавиша = document.createElement('kbd');
      клавиша.textContent = что.key;
      шапка.appendChild(клавиша);
    }
    карта.appendChild(шапка);
    if (что.text) {
      const описание = document.createElement('div');
      описание.className = 'tip-text';
      описание.textContent = что.text;
      карта.appendChild(описание);
    }

    // Карточка живёт под масштабом интерфейса (zoom на body), а рамка
    // элемента приходит в пикселях экрана — переводим в её координаты.
    const k = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const r = узел.getBoundingClientRect();
    const э = { l: r.left / k, r: r.right / k, t: r.top / k, b: r.bottom / k };
    карта.classList.add('on');
    const w = карта.offsetWidth, h = карта.offsetHeight;
    const вид = { w: innerWidth / k, h: innerHeight / k };
    const поле = 6, зазор = 8;
    let x, y;
    if (узел.closest('#toolbar')) {
      // Колонка инструментов у левого края — карточка справа от значка.
      x = э.r + зазор;
      y = (э.t + э.b) / 2 - h / 2;
    } else {
      // Остальное — под элементом, а если внизу тесно — над ним.
      x = (э.l + э.r) / 2 - w / 2;
      y = э.b + зазор;
      if (y + h > вид.h - поле) y = э.t - h - зазор;
    }
    x = Math.max(поле, Math.min(вид.w - w - поле, x));
    y = Math.max(поле, Math.min(вид.h - h - поле, y));
    карта.style.left = x + 'px';
    карта.style.top = y + 'px';
    текущий = узел;
  };

  document.addEventListener('pointerover', (e) => {
    const узел = e.target.closest?.('[data-tip], [title], [data-tip-text]');
    if (!узел) return;
    // Свежий title всегда главнее запомненного: его могли перевести.
    if (узел.hasAttribute('title')) {
      const строка = узел.getAttribute('title');
      узел.removeAttribute('title');
      if (строка) узел.dataset.tipText = строка;
    }
    // Движение по дочерним элементам той же кнопки — не новый показ.
    if (узел === текущий || узел === ждёт) return;
    clearTimeout(таймер);
    ждёт = null;
    const сразу = текущий || performance.now() - скрытоВ < ПОДРЯД;
    if (сразу) { показать(узел); return; }
    ждёт = узел;
    таймер = setTimeout(() => { ждёт = null; if (узел.isConnected) показать(узел); }, ЗАДЕРЖКА);
  });
  document.addEventListener('pointerout', (e) => {
    const узел = e.target.closest?.('[data-tip], [data-tip-text]');
    if (!узел || узел.contains(e.relatedTarget)) return;
    спрятать();
  });
  // Нажали — значит уже знают, что это; карточка только мешала бы.
  document.addEventListener('pointerdown', () => { спрятать(); скрытоВ = 0; }, true);
  document.addEventListener('wheel', спрятать, { passive: true, capture: true });
  window.addEventListener('blur', спрятать);
}

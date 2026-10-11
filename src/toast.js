/**
 * Плашка итога: «Сохранено — что и куда» или «Не сохранено — почему».
 *
 * Строка состояния внизу держит сообщение пару секунд мелким шрифтом, и
 * владелец дважды решил, что сохранение «ничего не сделало». Итог долгой
 * работы должен быть заметен: карточка в углу, висит, пока её читают
 * (наведение мыши останавливает отсчёт), и в приложении — кнопка
 * «Показать в Finder».
 *
 * Надписи — ключами: плашка переживает смену языка и перерисовывается.
 */

import { t, onLangChange } from './i18n.js';

const ВИСИТ = 8000;          // мс: успеть прочесть имя и найти кнопку
const ВИСИТ_ОШИБКА = 15000;  // ошибку читают дольше

const эл = (тег, класс) => {
  const у = document.createElement(тег);
  if (класс) у.className = класс;
  return у;
};

let карточка = null, значок, заголовок, имя, где, кнопка, крестик;
let текущее = null;          // что показано: { ok, name, parent, count, download, message, onReveal }
let таймер = 0;

function построить() {
  if (карточка) return;
  карточка = эл('div', 'toast');
  карточка.setAttribute('role', 'status');
  карточка.setAttribute('aria-live', 'polite');
  значок = эл('div', 'toast-icon');
  const текст = эл('div', 'toast-text');
  заголовок = эл('div', 'toast-title');
  имя = эл('div', 'toast-name');
  где = эл('div', 'toast-where');
  текст.append(заголовок, имя, где);
  кнопка = эл('button', 'btn accent toast-reveal');
  крестик = эл('button', 'toast-x');
  крестик.textContent = '×';
  карточка.append(значок, текст, кнопка, крестик);
  document.body.appendChild(карточка);

  крестик.addEventListener('click', спрятать);
  кнопка.addEventListener('click', async () => {
    const т = текущее;
    try { т.открыто = await т?.onReveal?.(); } catch (e) { console.error(e); т.открыто = 'ошибка: ' + e.message; }
  });
  // Пока мышь на плашке — не уходит: человек читает или тянется к кнопке.
  карточка.addEventListener('pointerenter', () => clearTimeout(таймер));
  карточка.addEventListener('pointerleave', () => завести(2500));
  onLangChange(нарисовать);
}

function нарисовать() {
  const т = текущее;
  if (!карточка || !т) return;
  карточка.classList.toggle('bad', !т.ok);
  значок.textContent = т.ok ? '✓' : '!';
  заголовок.textContent = t(т.ok ? 'saved.title' : 'saved.failedTitle');
  имя.textContent = т.ok ? т.name : т.message;
  имя.title = имя.textContent;
  const части = [];
  if (т.ok && т.download) части.push(t('saved.download'));
  else if (т.ok && т.parent) части.push(t('saved.inFolder', т.parent));
  if (т.ok && т.count > 1) части.push(t('saved.count', т.count));
  где.textContent = части.join(' · ');
  где.hidden = !части.length;
  кнопка.hidden = !т.onReveal;
  кнопка.textContent = t(navigator.userAgent.includes('Windows') ? 'saved.revealWin' : 'saved.revealMac');
  крестик.title = t('modal.closeTip');
}

function завести(мс) {
  clearTimeout(таймер);
  таймер = setTimeout(спрятать, мс);
}

export function спрятать() {
  clearTimeout(таймер);
  карточка?.classList.remove('on');
}

/**
 * Показать итог сохранения.
 * @param {{name: string, parent?: string, count?: number, download?: boolean}} итог
 * @param {(() => Promise<any>)|null} onReveal кнопка «Показать в Finder»; null — без неё
 */
export function showSaved(итог, onReveal = null) {
  построить();
  текущее = { ok: true, ...итог, onReveal };
  нарисовать();
  карточка.classList.add('on');
  завести(ВИСИТ);
}

/** Показать, что сохранить не вышло, и почему. */
export function showSaveFailed(message) {
  построить();
  текущее = { ok: false, message, onReveal: null };
  нарисовать();
  карточка.classList.add('on');
  завести(ВИСИТ_ОШИБКА);
}

/** Для проверок: что сейчас на плашке. */
export function toastState() {
  if (!карточка || !карточка.classList.contains('on')) return null;
  return { ok: текущее.ok, title: заголовок.textContent, name: имя.textContent, where: где.hidden ? '' : где.textContent,
    reveal: !кнопка.hidden, revealText: кнопка.textContent, opened: текущее.открыто ?? null };
}

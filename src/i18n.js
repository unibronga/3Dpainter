/**
 * Язык интерфейса.
 *
 * Словари лежат по файлу на язык в `lang/`: добавить перевод — значит
 * добавить файл и строчку в LANGS, не трогая остальной код.
 *
 * Плоские ключи вида 'file.open'. Смена языка не
 * перезагружает страницу: подписчики перерисовывают свои надписи сами —
 * иначе пришлось бы терять покраску ради переключения языка.
 *
 * Разметка переводится атрибутами: data-i18n — текст узла,
 * data-i18n-title — подсказка, data-i18n-ph — placeholder.
 */

import ru from './lang/ru.js';
import en from './lang/en.js';

/** Языки, между которыми переключается интерфейс. */
export const LANGS = { ru: 'Русский', en: 'English' };

const СЛОВАРИ = { ru, en };

/** Какие ключи есть в русском, но потерялись в другом языке. */
export function missingKeys(код) {
  const свой = СЛОВАРИ[код] || {};
  return Object.keys(ru).filter((k) => !(k in свой));
}

const КЛЮЧ_НАСТРОЙКИ = 'paint-tool.lang';
const подписчики = new Set();

/** Язык из настроек, иначе язык браузера, иначе русский. */
function языкПоУмолчанию() {
  try {
    const сохранённый = localStorage.getItem(КЛЮЧ_НАСТРОЙКИ);
    if (сохранённый && СЛОВАРИ[сохранённый]) return сохранённый;
  } catch { /* приватный режим */ }
  const браузер = (navigator.language || 'ru').slice(0, 2).toLowerCase();
  return СЛОВАРИ[браузер] ? браузер : 'ru';
}

let текущий = языкПоУмолчанию();

export function getLang() { return текущий; }

/**
 * Перевод по ключу. Подстановки нумерованные: t('load.ok', имя, 3, 120).
 * Неизвестный ключ возвращается как есть — так пропущенный перевод видно
 * на экране, а не теряется в молчаливом пустом месте.
 */
export function t(ключ, ...значения) {
  const строка = СЛОВАРИ[текущий]?.[ключ] ?? СЛОВАРИ.ru[ключ] ?? ключ;
  return значения.length
    ? строка.replace(/\{(\d+)\}/g, (_, i) => значения[+i] ?? '')
    : строка;
}

export function setLang(код) {
  if (!СЛОВАРИ[код] || код === текущий) return;
  текущий = код;
  try { localStorage.setItem(КЛЮЧ_НАСТРОЙКИ, код); } catch { /* приватный режим */ }
  document.documentElement.lang = код;
  applyDOM();
  подписчики.forEach((fn) => fn(код));
}

/** Подписка на смену языка; возвращает отписку. */
export function onLangChange(fn) {
  подписчики.add(fn);
  return () => подписчики.delete(fn);
}

/** Перевести разметку: data-i18n, data-i18n-title, data-i18n-ph. */
export function applyDOM(корень = document) {
  корень.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  корень.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  корень.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

document.documentElement.lang = текущий;

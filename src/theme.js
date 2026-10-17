/**
 * Тема интерфейса: тёмная, светлая или «как в системе».
 *
 * Выбор человека — `pref` ('dark' | 'light' | 'system'), на странице всегда
 * стоит уже решённая тема: `<html data-theme="dark|light">`. Поэтому в CSS
 * одна палитра по умолчанию (тёмная) и одна поправка `[data-theme="light"]`,
 * без третьей копии токенов под `prefers-color-scheme`. «Как в системе»
 * слушает смену темы macOS и Windows на лету.
 *
 * Холсты — фон сцены, сетка пола, подложка развёртки, куб — рисуются кодом и
 * CSS не видят: берут цвета токенами через `themeColor()` и перерисовываются
 * по `onThemeChange`.
 *
 * Выбор лежит в общих настройках интерфейса (`paint-tool.ui`, поле `theme`):
 * его же читает ранний скрипт в index.html, чтобы окно не мигнуло не той
 * темой до загрузки модулей.
 */

const PREFS = 'paint-tool.ui';
export const THEMES = ['light', 'dark', 'system'];

const подписчики = new Set();
const системная = window.matchMedia?.('(prefers-color-scheme: dark)');

function читать() {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; }
}

let выбор = THEMES.includes(читать().theme) ? читать().theme : 'dark';

/** Какая тема на самом деле: «как в системе» решается по системе. */
function решить(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return системная && !системная.matches ? 'light' : 'dark';
}

function применить() {
  const тема = решить(выбор);
  const было = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = тема;
  if (было !== тема) подписчики.forEach((f) => f(тема));
}

/** Выбор человека: 'light' | 'dark' | 'system'. */
export function getThemePref() { return выбор; }

/** Тема на экране: 'light' | 'dark'. */
export function getTheme() { return решить(выбор); }

export function setThemePref(pref) {
  выбор = THEMES.includes(pref) ? pref : 'dark';
  try { localStorage.setItem(PREFS, JSON.stringify({ ...читать(), theme: выбор })); } catch { /* приватный режим */ }
  применить();
}

/** Подписка на смену темы на экране (не выбора: «как в системе» тоже меняет). */
export function onThemeChange(f) { подписчики.add(f); }

/** Цвет токена CSS, например themeColor('--well'). */
export function themeColor(имя, запас = '#000') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(имя).trim();
  return v || запас;
}

системная?.addEventListener?.('change', () => { if (выбор === 'system') применить(); });
// Событие смены рассылается в такт отрисовки: у свёрнутого или скрытого окна
// кадров нет, и тема системы, сменённая в это время, пришла бы с опозданием.
// Вернулись к окну — сверить ещё раз.
document.addEventListener('visibilitychange', () => { if (выбор === 'system') применить(); });
window.addEventListener('focus', () => { if (выбор === 'system') применить(); });
применить();

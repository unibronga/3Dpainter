/**
 * Начальный экран.
 *
 * Первое, что видит человек: с чего начать — открыть свою модель или взять
 * демо-хижину и красить прямо сейчас. Рядом — то, что уже открывали.
 *
 * Экран накрывает всё окно, но программа под ним живая и готовая: закрыть
 * его можно в любой момент, и ничего не потеряется.
 */

import { t, onLangChange } from './i18n.js';
import значокПрограммы from './app-icon.png';
import { listRecent, getRecent, removeRecent } from './recent.js';

const эл = (тег, класс, текст) => {
  const у = document.createElement(тег);
  if (класс) у.className = класс;
  if (текст != null) у.textContent = текст;
  return у;
};

function размерЧеловеку(байты) {
  if (байты > 1024 * 1024) return (байты / 1024 / 1024).toFixed(1) + ' MB';
  if (байты > 1024) return Math.round(байты / 1024) + ' KB';
  return байты + ' B';
}

function датаЧеловеку(время, язык) {
  try {
    return new Date(время).toLocaleDateString(язык === 'en' ? 'en-US' : 'ru-RU',
      { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

/**
 * @param {{openFile: (File) => Promise<boolean>,
 *          openBuffer: (ArrayBuffer, string) => Promise<boolean>,
 *          openDemo: () => void,
 *          getShowOnStartup: () => boolean,
 *          setShowOnStartup: (boolean) => void,
 *          pickFile: () => void}} api
 */
export function createWelcome(api) {
  const слой = эл('div', 'welcome-back');
  const окно = эл('div', 'welcome');

  /* Шапка: значок, имя программы и одна строка о том, что она делает */
  const шапка = эл('div', 'welcome-head');

  const значок = эл('img', 'welcome-icon');
  значок.src = значокПрограммы;
  значок.alt = '';
  значок.width = 72;
  значок.height = 72;

  const надписи = эл('div', 'welcome-titles');
  const заголовок = эл('h1', 'welcome-title', t('welcome.title'));
  const подзаголовок = эл('p', 'welcome-sub', t('welcome.subtitle'));
  надписи.append(заголовок, подзаголовок);

  шапка.append(значок, надписи);

  /* Две дороги: своя модель или демо */
  const карточки = эл('div', 'welcome-cards');

  function карточка(значок, ключИмени, ключПодсказки, действие) {
    const к = эл('button', 'welcome-card');
    const ико = эл('div', 'welcome-ico');
    ико.innerHTML = значок;
    const имя = эл('div', 'welcome-card-name', t(ключИмени));
    const подсказка = эл('div', 'welcome-card-hint', t(ключПодсказки));
    к.append(ико, имя, подсказка);
    к.addEventListener('click', действие);
    карточки.appendChild(к);
    return { имя, подсказка, ключИмени, ключПодсказки };
  }

  const ЗНАЧОК_ОТКРЫТЬ = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/><path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/></svg>';
  const ЗНАЧОК_ДЕМО = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 12 5l8 5.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.5 20v-6h5v6"/></svg>';

  const картОткрыть = карточка(ЗНАЧОК_ОТКРЫТЬ, 'welcome.open', 'welcome.openHint', () => api.pickFile());
  const картДемо = карточка(ЗНАЧОК_ДЕМО, 'welcome.demo', 'welcome.demoHint', () => { api.openDemo(); скрыть(); });

  /* Недавние */
  const блокНедавних = эл('div', 'welcome-recent');
  const подписьНедавних = эл('div', 'welcome-recent-title', t('welcome.recent'));
  const списокНедавних = эл('div', 'welcome-recent-list');
  блокНедавних.append(подписьНедавних, списокНедавних);

  /* Подвал */
  const подвал = эл('div', 'welcome-foot');
  const метка = эл('label', 'welcome-check');
  const галка = эл('input');
  галка.type = 'checkbox';
  галка.checked = !api.getShowOnStartup();
  галка.addEventListener('change', () => api.setShowOnStartup(!галка.checked));
  const текстГалки = эл('span', null, t('welcome.dontShow'));
  метка.append(галка, текстГалки);
  const закрыть = эл('button', 'btn', t('welcome.close'));
  закрыть.addEventListener('click', скрыть);
  подвал.append(метка, эл('div', 'spacer'), закрыть);

  окно.append(шапка, карточки, блокНедавних, подвал);
  слой.appendChild(окно);
  document.body.appendChild(слой);

  /* Перетаскивание прямо на начальный экран */
  слой.addEventListener('dragover', (e) => { e.preventDefault(); слой.classList.add('drag'); });
  слой.addEventListener('dragleave', (e) => { if (e.target === слой) слой.classList.remove('drag'); });
  слой.addEventListener('drop', async (e) => {
    e.preventDefault();
    слой.classList.remove('drag');
    const файл = e.dataTransfer.files[0];
    if (файл && await api.openFile(файл)) скрыть();
  });

  async function нарисоватьНедавние(язык) {
    списокНедавних.textContent = '';
    const список = await listRecent();

    if (!список.length) {
      списокНедавних.appendChild(эл('div', 'welcome-recent-empty', t('welcome.recentEmpty')));
      return;
    }

    for (const з of список) {
      const строка = эл('button', 'welcome-recent-row');
      строка.append(
        эл('span', 'welcome-recent-name', з.name),
        эл('span', 'welcome-recent-meta', `${размерЧеловеку(з.size)} · ${датаЧеловеку(з.opened, язык)}`),
      );
      строка.addEventListener('click', async () => {
        const запись = await getRecent(з.id);
        if (!запись) { await removeRecent(з.id); нарисоватьНедавние(язык); return; }
        if (await api.openBuffer(запись.buffer, запись.name)) скрыть();
      });
      списокНедавних.appendChild(строка);
    }
  }

  function перевести() {
    заголовок.textContent = t('welcome.title');
    подзаголовок.textContent = t('welcome.subtitle');
    for (const к of [картОткрыть, картДемо]) {
      к.имя.textContent = t(к.ключИмени);
      к.подсказка.textContent = t(к.ключПодсказки);
    }
    подписьНедавних.textContent = t('welcome.recent');
    текстГалки.textContent = t('welcome.dontShow');
    закрыть.textContent = t('welcome.close');
    нарисоватьНедавние(document.documentElement.lang);
  }

  function показать() {
    галка.checked = !api.getShowOnStartup();
    нарисоватьНедавние(document.documentElement.lang);
    слой.classList.add('open');
  }

  function скрыть() { слой.classList.remove('open'); }

  onLangChange(перевести);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && слой.classList.contains('open')) скрыть();
  });

  return { show: показать, hide: скрыть, isOpen: () => слой.classList.contains('open'), refresh: нарисоватьНедавние };
}

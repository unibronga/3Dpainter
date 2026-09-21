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
import { listRecent, getRecent, removeRecent, setThumb } from './recent.js';

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

  /* Недавние: список слева во фрейме, превью выбранной модели справа */
  const блокНедавних = эл('div', 'welcome-recent');
  const подписьНедавних = эл('div', 'welcome-recent-title', t('welcome.recent'));
  const телоНедавних = эл('div', 'welcome-recent-body');
  const списокНедавних = эл('div', 'welcome-recent-list');

  const сторона = эл('div', 'welcome-recent-side');
  const рамкаПревью = эл('div', 'welcome-preview');
  const картинкаПревью = эл('img', 'welcome-preview-img');
  картинкаПревью.alt = '';
  const подсказкаПревью = эл('div', 'welcome-preview-hint', t('welcome.pickRecent'));
  рамкаПревью.append(картинкаПревью, подсказкаПревью);
  const имяПревью = эл('div', 'welcome-preview-name', '');
  const кнопкаОткрыть = эл('button', 'btn primary welcome-preview-open', t('welcome.openSelected'));
  кнопкаОткрыть.disabled = true;
  кнопкаОткрыть.addEventListener('click', () => открытьВыбранное());
  сторона.append(рамкаПревью, имяПревью, кнопкаОткрыть);

  телоНедавних.append(списокНедавних, сторона);
  блокНедавних.append(подписьНедавних, телоНедавних);

  let выбранное = null;     // карточка выбранной записи
  let поколение = 0;        // чтобы опоздавшее превью не легло поверх нового выбора

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
    const набор = [...e.dataTransfer.files];
    if (набор.length && await api.openFile(набор)) скрыть();
  });

  /** Открыть то, что выбрано в списке. */
  async function открытьВыбранное() {
    if (!выбранное) return;
    const запись = await getRecent(выбранное.id);
    if (!запись) {   // файл выпал из хранилища — убираем строку, а не молчим
      await removeRecent(выбранное.id);
      выбранное = null;
      нарисоватьНедавние(document.documentElement.lang);
      return;
    }
    if (await api.openBuffer(запись.buffer, запись.name)) скрыть();
  }

  /**
   * Показать выбранную запись справа.
   *
   * Превью у записи может не быть: снимки появились позже самих недавних, и
   * у старых записей их нет. Тогда рисуем его по содержимому файла и тут же
   * дописываем в базу — второй раз ждать уже не придётся.
   */
  async function выбрать(з, строка) {
    выбранное = з;
    поколение += 1;
    const моё = поколение;

    [...списокНедавних.children].forEach((э) => э.classList.toggle('on', э === строка));
    имяПревью.textContent = з.name;
    кнопкаОткрыть.disabled = false;

    if (з.thumb) {
      картинкаПревью.src = з.thumb;
      рамкаПревью.classList.add('has-img');
      подсказкаПревью.textContent = '';
      return;
    }

    картинкаПревью.removeAttribute('src');
    рамкаПревью.classList.remove('has-img');
    подсказкаПревью.textContent = t('welcome.previewBuilding');

    const запись = await getRecent(з.id);
    if (моё !== поколение) return;            // за это время выбрали другое
    if (!запись) { подсказкаПревью.textContent = t('welcome.previewNone'); return; }

    const { нарисоватьПревью } = await import('./thumb.js');
    const картинка = await нарисоватьПревью(запись.buffer, запись.name);
    if (моё !== поколение) return;
    if (!картинка) { подсказкаПревью.textContent = t('welcome.previewNone'); return; }

    з.thumb = картинка;
    картинкаПревью.src = картинка;
    рамкаПревью.classList.add('has-img');
    подсказкаПревью.textContent = '';
    setThumb(з.id, картинка);
  }

  async function нарисоватьНедавние(язык) {
    списокНедавних.textContent = '';
    выбранное = null;
    поколение += 1;
    картинкаПревью.removeAttribute('src');
    рамкаПревью.classList.remove('has-img');
    подсказкаПревью.textContent = t('welcome.pickRecent');
    имяПревью.textContent = '';
    кнопкаОткрыть.disabled = true;

    const список = await listRecent();
    блокНедавних.classList.toggle('empty', !список.length);

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
      // Щелчок выбирает, а не открывает: сначала посмотреть, потом решить.
      // Двойной щелчок — для тех, кто и так знает, что открывает.
      строка.addEventListener('click', () => выбрать(з, строка));
      строка.addEventListener('dblclick', () => открытьВыбранное());
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
    кнопкаОткрыть.textContent = t('welcome.openSelected');
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

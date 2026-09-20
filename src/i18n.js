/**
 * Язык интерфейса.
 *
 * Один словарь на язык, плоские ключи вида 'file.open'. Смена языка не
 * перезагружает страницу: подписчики перерисовывают свои надписи сами —
 * иначе пришлось бы терять покраску ради переключения языка.
 *
 * Разметка переводится атрибутами: data-i18n — текст узла,
 * data-i18n-title — подсказка, data-i18n-ph — placeholder.
 */

export const LANGS = { ru: 'Русский', en: 'English' };

const СЛОВАРИ = {
  ru: {
    /* Меню */
    'menu.file': 'Файл',
    'menu.edit': 'Правка',
    'menu.layer': 'Слой',
    'menu.view': 'Вид',
    'menu.tool': 'Инструмент',
    'menu.panels': 'Панели',
    'menu.help': 'Справка',

    'file.open': 'Открыть модель…',
    'file.demo': 'Демо-модель',
    'file.start': 'Начальный экран…',
    'file.saveAs': 'Сохранить как…',
    'file.savePng': 'Сохранить карты PNG',
    'file.settings': 'Настройки…',
    'file.texSize': 'Размер текстуры',

    'edit.undo': 'Отменить',
    'edit.redo': 'Вернуть',
    'edit.toStart': 'К исходному состоянию',
    'edit.toEnd': 'К последнему шагу',

    'layer.new': 'Новый слой',
    'layer.mask': 'Маска слоя',
    'layer.remove': 'Удалить слой',
    'layer.blend.normal': 'Наложение: обычное',
    'layer.blend.multiply': 'Наложение: умножение',
    'layer.blend.screen': 'Наложение: экран',

    'view.front': 'Спереди',
    'view.back': 'Сзади',
    'view.left': 'Слева',
    'view.right': 'Справа',
    'view.top': 'Сверху',
    'view.bottom': 'Снизу',
    'view.user': 'Три четверти',
    'view.ortho': 'Ортография',
    'view.fit': 'Вписать в кадр',
    'view.pivot.world': 'Вращать вокруг мира',
    'view.pivot.local': 'Вращать вокруг объекта',
    'view.pivot.camera': 'Вращать вокруг точки взгляда',
    'view.flat': 'Показ плоско',
    'view.grid': 'Сетка пола',
    'view.wire': 'Сетка модели',

    'tool.brush': 'Кисть',
    'tool.eraser': 'Ластик',
    'tool.eyedropper': 'Пипетка',
    'tool.fillFaces': 'Заливка связанных граней',
    'tool.fillIsland': 'Заливка UV-острова',
    'tool.fillLayer': 'Залить весь слой',
    'tool.mask': 'Кисть по маске',
    'tool.rect': 'Прямоугольник',
    'tool.ellipse': 'Круг',
    'tool.text': 'Текст',
    'tool.brushes': 'Кисти…',
    'tool.materials': 'Материалы и цвет…',

    'panels.uv': 'Развёртка',
    'panels.uvWire': 'Сетка развёртки',
    'panels.tools': 'Колонка инструментов',
    'panels.side': 'Правая панель',
    'panels.hideAll': 'Скрыть всё',

    'help.keys': 'Клавиши и приёмы…',

    /* Начальный экран */
    'welcome.title': 'Покраска',
    'welcome.subtitle': 'Красьте low-poly модель кистью прямо по поверхности',
    'welcome.open': 'Открыть модель',
    'welcome.openHint': 'GLB, OBJ, FBX, DAE, 3MF, STL, PLY и другие',
    'welcome.demo': 'Начать с демо-модели',
    'welcome.demoHint': 'Хижина с честной развёрткой — можно красить сразу',
    'welcome.recent': 'Недавние',
    'welcome.recentEmpty': 'Здесь появятся модели, которые вы открывали',
    'welcome.drop': 'Перетащите файл модели сюда',
    'welcome.dontShow': 'Не показывать при запуске',
    'welcome.close': 'Закрыть',

    /* Сохранение */
    'save.title': 'Сохранить как',
    'save.what': 'Что сохранить',
    'save.format': 'Формат',
    'save.model': 'Модель вместе с покраской',
    'save.modelHint': 'Готовый ассет: геометрия, развёртка и карты в одном файле',
    'save.maps': 'Только карты',
    'save.mapsHint': 'PNG цвета и, если красили поверхностью, карта материала',
    'save.glb': 'GLB — один файл, для движков и просмотрщиков',
    'save.gltf': 'glTF — текст плюс отдельные карты',
    'save.obj': 'OBJ + MTL — для Blender, 3ds Max, Maya',
    'save.png': 'PNG — только карты',
    'save.go': 'Сохранить',
    'save.cancel': 'Отмена',
    'save.done': 'сохранено файлов: {0}',
    'save.nothing': 'нечего сохранять: модель не открыта',

    /* Настройки */
    'settings.title': 'Настройки',
    'settings.language': 'Язык интерфейса',
    'settings.languageHint': 'Меняется сразу, покраска не теряется',
    'settings.startup': 'Начальный экран',
    'settings.startupShow': 'Показывать при запуске',
    'settings.texture': 'Размер текстуры по умолчанию',
    'settings.textureHint': 'Крупнее — чётче мазок, но больше памяти на каждый слой',
    'settings.view': 'Вид',
    'settings.gridOn': 'Сетка пола включена',
    'settings.close': 'Готово',

    /* Загрузка моделей */
    'load.loading': 'читаю {0}…',
    'load.failed': 'не смог открыть {0}: {1}',
    'load.unknown': 'формат не поддерживается: {0}',
    'load.noMesh': 'в файле нет ни одного меша',
    'load.noUV': 'без развёртки, красить нечем: {0}',
    'load.overlap': 'развёртка с наложением ({0}%) — мазок будет дублироваться: {1}',
    'load.ok': '{0} · мешей: {1} · трис: {2}',
  },

  en: {
    /* Menu */
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.layer': 'Layer',
    'menu.view': 'View',
    'menu.tool': 'Tool',
    'menu.panels': 'Panels',
    'menu.help': 'Help',

    'file.open': 'Open model…',
    'file.demo': 'Demo model',
    'file.start': 'Start screen…',
    'file.saveAs': 'Save as…',
    'file.savePng': 'Save PNG maps',
    'file.settings': 'Settings…',
    'file.texSize': 'Texture size',

    'edit.undo': 'Undo',
    'edit.redo': 'Redo',
    'edit.toStart': 'Back to original',
    'edit.toEnd': 'Forward to latest',

    'layer.new': 'New layer',
    'layer.mask': 'Layer mask',
    'layer.remove': 'Delete layer',
    'layer.blend.normal': 'Blend: normal',
    'layer.blend.multiply': 'Blend: multiply',
    'layer.blend.screen': 'Blend: screen',

    'view.front': 'Front',
    'view.back': 'Back',
    'view.left': 'Left',
    'view.right': 'Right',
    'view.top': 'Top',
    'view.bottom': 'Bottom',
    'view.user': 'Three-quarter',
    'view.ortho': 'Orthographic',
    'view.fit': 'Fit to frame',
    'view.pivot.world': 'Orbit around world',
    'view.pivot.local': 'Orbit around object',
    'view.pivot.camera': 'Orbit around focus point',
    'view.flat': 'Flat display',
    'view.grid': 'Floor grid',
    'view.wire': 'Model wireframe',

    'tool.brush': 'Brush',
    'tool.eraser': 'Eraser',
    'tool.eyedropper': 'Eyedropper',
    'tool.fillFaces': 'Fill connected faces',
    'tool.fillIsland': 'Fill UV island',
    'tool.fillLayer': 'Fill whole layer',
    'tool.mask': 'Mask brush',
    'tool.rect': 'Rectangle',
    'tool.ellipse': 'Ellipse',
    'tool.text': 'Text',
    'tool.brushes': 'Brushes…',
    'tool.materials': 'Materials and color…',

    'panels.uv': 'UV editor',
    'panels.uvWire': 'UV wireframe',
    'panels.tools': 'Tool column',
    'panels.side': 'Side panel',
    'panels.hideAll': 'Hide everything',

    'help.keys': 'Keys and tips…',

    /* Start screen */
    'welcome.title': '3D Painter',
    'welcome.subtitle': 'Paint a low-poly model with a brush, right on its surface',
    'welcome.open': 'Open a model',
    'welcome.openHint': 'GLB, OBJ, FBX, DAE, 3MF, STL, PLY and more',
    'welcome.demo': 'Start with the demo model',
    'welcome.demoHint': 'A cabin with a clean unwrap — paint right away',
    'welcome.recent': 'Recent',
    'welcome.recentEmpty': 'Models you open will show up here',
    'welcome.drop': 'Drop a model file here',
    'welcome.dontShow': 'Do not show on startup',
    'welcome.close': 'Close',

    /* Saving */
    'save.title': 'Save as',
    'save.what': 'What to save',
    'save.format': 'Format',
    'save.model': 'Model together with the paint',
    'save.modelHint': 'A finished asset: geometry, UVs and maps in one file',
    'save.maps': 'Maps only',
    'save.mapsHint': 'Color PNG and, if you painted surface, the material map',
    'save.glb': 'GLB — a single file, for engines and viewers',
    'save.gltf': 'glTF — text plus separate maps',
    'save.obj': 'OBJ + MTL — for Blender, 3ds Max, Maya',
    'save.png': 'PNG — maps only',
    'save.go': 'Save',
    'save.cancel': 'Cancel',
    'save.done': 'files saved: {0}',
    'save.nothing': 'nothing to save: no model is open',

    /* Settings */
    'settings.title': 'Settings',
    'settings.language': 'Interface language',
    'settings.languageHint': 'Applies immediately, your paint is kept',
    'settings.startup': 'Start screen',
    'settings.startupShow': 'Show on startup',
    'settings.texture': 'Default texture size',
    'settings.textureHint': 'Larger is crisper, but costs more memory per layer',
    'settings.view': 'View',
    'settings.gridOn': 'Floor grid on',
    'settings.close': 'Done',

    /* Loading */
    'load.loading': 'reading {0}…',
    'load.failed': 'could not open {0}: {1}',
    'load.unknown': 'unsupported format: {0}',
    'load.noMesh': 'the file has no meshes',
    'load.noUV': 'no UVs, nothing to paint on: {0}',
    'load.overlap': 'overlapping UVs ({0}%) — strokes will be duplicated: {1}',
    'load.ok': '{0} · meshes: {1} · tris: {2}',
  },
};

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

/**
 * Сохранение нескольких файлов разом — в одну папку.
 *
 * Каждый файл, отданный «скачиванием», Electron встречает своим окном
 * сохранения: OBJ с материалом и картой — это три окна подряд. Поэтому
 * наборы сохраняются иначе: человек один раз выбирает место, программа
 * создаёт там папку с именем модели и кладёт в неё всё.
 *
 * Работает через File System Access — он есть в Chromium, а значит и в
 * браузере, и в собранном приложении, и Node странице для этого не нужен.
 * Где его нет (Safari, Firefox), файлы уходят обычными скачиваниями: там
 * они молча ложатся в «Загрузки», без окон.
 *
 * В приложении место выбирает оболочка системным окном (`painterHost.files`):
 * окно File System Access пути не отдаёт, а без пути итог нельзя показать в
 * Finder. Страница знает место по номеру. Каждая запись возвращает итог —
 * `{name, parent?, count, reveal?}` — для плашки «Сохранено».
 */

const host = () => window.painterHost?.files || null;

/** Байты Blob — для передачи оболочке. */
const байты = async (blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * Имя, годное для файла на любой системе. Чистить надо ДО выгрузки: имя
 * попадает и внутрь файлов (OBJ ссылается на .mtl, .mtl — на картинку), и
 * если почистить только имена файлов, ссылки внутри перестанут совпадать.
 */
export function safeName(имя) {
  return имя.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'model';
}

/** Можно ли сохранять набором в папку. */
export function canSaveToFolder() {
  return !!host() || typeof window.showDirectoryPicker === 'function';
}

/**
 * Спросить, куда сохранять. Звать СРАЗУ по нажатию, до долгой работы:
 * окно выбора папки браузер открывает только в ответ на действие человека,
 * а экспорт под индикатором это право успел бы растратить.
 *
 * @returns {Promise<FileSystemDirectoryHandle|{id: number}|null>} null — отказались
 */
export async function pickFolder() {
  if (host()) return host().pickFolder();
  try {
    return await window.showDirectoryPicker({ id: '3dpainter-save', mode: 'readwrite', startIn: 'documents' });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;   // закрыли окно — не ошибка
    throw err;
  }
}

/**
 * Разложить файлы в новую папку внутри выбранной.
 *
 * Папка с таким именем уже есть — берём «имя 2», «имя 3»: чужие файлы
 * молча не перезаписываем.
 *
 * @param {FileSystemDirectoryHandle} место
 * @param {string} имяПапки
 * @param {{name: string, blob: Blob}[]} файлы
 * @returns {Promise<{name: string, count: number, parent?: string, reveal?: number}>} итог
 */
export async function writeToFolder(место, имяПапки, файлы) {
  if (host() && typeof место?.id === 'number') {
    const итог = await host().writeFolder(место.id, имяПапки,
      await Promise.all(файлы.map(async ({ name, blob }) => ({ name, bytes: await байты(blob) }))));
    return { name: итог.name, parent: итог.parent, count: итог.count, reveal: итог.id };
  }
  const чистое = имяПапки.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'model';
  let имя = чистое;
  for (let n = 2; await есть(место, имя); n++) имя = `${чистое} ${n}`;
  const папка = await место.getDirectoryHandle(имя, { create: true });
  for (const { name, blob } of файлы) {
    const файл = await папка.getFileHandle(name.replace(/[\\/:*?"<>|]+/g, '_'), { create: true });
    const поток = await файл.createWritable();
    await поток.write(blob);
    await поток.close();
  }
  return { name: имя, parent: место.name, count: файлы.length };
}

/**
 * Спросить, куда сохранить один файл. Как и папку — СРАЗУ по нажатию.
 * @returns {Promise<object|null|undefined>} место; null — отказались;
 *          undefined — спросить нечем, файл уйдёт скачиванием
 */
export async function pickFile(имя, тип = '') {
  if (host()) return host().pickFile(имя, тип);
  if (typeof window.showSaveFilePicker !== 'function') return undefined;
  const ext = (имя.match(/\.([^.]+)$/) || [])[1];
  try {
    return await window.showSaveFilePicker({
      suggestedName: имя, id: '3dpainter-file',
      types: ext ? [{ description: тип || ext.toUpperCase(), accept: { 'application/octet-stream': ['.' + ext] } }] : undefined,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    console.warn(err);
    return undefined;                   // не вышло — отдадим скачиванием
  }
}

/**
 * Записать один файл в выбранное место (или скачиванием, если места нет).
 * @returns {Promise<{name: string, count: 1, parent?: string, reveal?: number, download?: boolean}>}
 */
export async function writeFile(место, blob, имя) {
  if (host() && typeof место?.id === 'number') {
    const итог = await host().writeFile(место.id, await байты(blob));
    return { name: итог.name, parent: итог.parent, count: 1, reveal: итог.id };
  }
  if (место && typeof место.createWritable === 'function') {
    const поток = await место.createWritable();
    await поток.write(blob);
    await поток.close();
    return { name: место.name, count: 1 };
  }
  downloadBlob(blob, имя);
  return { name: имя, count: 1, download: true };
}

/** Показать сохранённое в Finder / Проводнике (только в приложении). */
export function canReveal(итог) {
  return !!host() && typeof итог?.reveal === 'number';
}
export function reveal(итог) {
  return host().reveal(итог.reveal);
}

async function есть(место, имя) {
  try { await место.getDirectoryHandle(имя); return true; } catch { return false; }
}

/** Отдать файл обычным скачиванием — для одиночных файлов и запасного пути. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Холст в PNG. */
export function canvasBlob(canvas) {
  return new Promise((ok) => canvas.toBlob(ok, 'image/png'));
}

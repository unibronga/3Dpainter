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
 */

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
  return typeof window.showDirectoryPicker === 'function';
}

/**
 * Спросить, куда сохранять. Звать СРАЗУ по нажатию, до долгой работы:
 * окно выбора папки браузер открывает только в ответ на действие человека,
 * а экспорт под индикатором это право успел бы растратить.
 *
 * @returns {Promise<FileSystemDirectoryHandle|null>} null — отказались
 */
export async function pickFolder() {
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
 * @returns {Promise<string>} имя созданной папки
 */
export async function writeToFolder(место, имяПапки, файлы) {
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
  return имя;
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

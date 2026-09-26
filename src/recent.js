/**
 * Недавние модели.
 *
 * Браузер не даёт открыть файл по пути: имени в списке мало, по нему модель
 * не вернуть. Поэтому храним сам файл в IndexedDB — тогда «недавние»
 * работают одинаково и в браузере, и в собранном приложении.
 *
 * Хранилище не бездонное: держим десяток последних и не берём файлы крупнее
 * порога — иначе пара тяжёлых сцен забьёт квоту и выгонит всё остальное.
 */

const БАЗА = 'paint-tool';
const ХРАНИЛИЩЕ = 'recent';
const СКОЛЬКО_ХРАНИМ = 10;
const ПРЕДЕЛ_БАЙТ = 64 * 1024 * 1024;

function открытьБазу() {
  return new Promise((ок, нет) => {
    const запрос = indexedDB.open(БАЗА, 1);
    запрос.onupgradeneeded = () => {
      const db = запрос.result;
      if (!db.objectStoreNames.contains(ХРАНИЛИЩЕ)) {
        db.createObjectStore(ХРАНИЛИЩЕ, { keyPath: 'id' });
      }
    };
    запрос.onsuccess = () => ок(запрос.result);
    запрос.onerror = () => нет(запрос.error);
  });
}

function вТранзакции(режим, дело) {
  return открытьБазу().then((db) => new Promise((ок, нет) => {
    const тр = db.transaction(ХРАНИЛИЩЕ, режим);
    const результат = дело(тр.objectStore(ХРАНИЛИЩЕ));
    тр.oncomplete = () => { db.close(); ок(результат?.result ?? результат); };
    тр.onerror = () => { db.close(); нет(тр.error); };
  }));
}

/** Ключ записи. Считается в одном месте: по нему же дописывается превью. */
export function recentId(name, size) {
  return `${name}:${size}`;
}

/**
 * Список недавних, новые сверху. Без содержимого файлов — карточки и превью:
 * картинка маленькая, а ради неё иначе пришлось бы тянуть модель целиком.
 */
export async function listRecent() {
  try {
    const всё = await вТранзакции('readonly', (хр) => хр.getAll());
    return (всё || [])
      .map(({ id, name, size, opened, thumb }) => ({ id, name, size, opened, thumb: thumb || null }))
      .sort((a, b) => b.opened - a.opened)
      .slice(0, СКОЛЬКО_ХРАНИМ);
  } catch {
    return [];   // приватный режим или запрет хранилища — просто нет списка
  }
}

/**
 * Дописать превью к уже сохранённой записи.
 *
 * Отдельным шагом, а не полем в `addRecent`: снимок можно сделать лишь после
 * того, как модель разобрана и скадрирована, то есть заметно позже.
 */
export async function setThumb(id, thumb) {
  if (!thumb) return false;
  try {
    const запись = await вТранзакции('readonly', (хр) => хр.get(id));
    if (!запись) return false;
    запись.thumb = thumb;
    await вТранзакции('readwrite', (хр) => хр.put(запись));
    return true;
  } catch {
    return false;
  }
}

/**
 * Достать файл целиком, чтобы открыть его заново. Соседние файлы (`.mtl`,
 * текстуры) приходят словарём «имя → содержимое» — в том виде, в каком их
 * ждёт загрузчик.
 */
export async function getRecent(id) {
  try {
    const запись = await вТранзакции('readonly', (хр) => хр.get(id));
    if (!запись) return null;
    запись.sidecars = new Map(запись.sidecars || []);
    return запись;
  } catch {
    return null;
  }
}

/**
 * Запомнить открытый файл вместе с соседними. Слишком крупные не храним —
 * молча и честно.
 *
 * Соседние файлы — это `.mtl` и текстуры, открытые вместе с моделью: без них
 * OBJ из недавних приходил белым, цвета материалов жили в `.mtl`.
 *
 * @param {Map<string, ArrayBuffer>} [sidecars] имя → содержимое
 */
export async function addRecent(name, buffer, sidecars = null) {
  if (!buffer) return false;
  let всего = buffer.byteLength;
  for (const b of sidecars?.values() || []) всего += b.byteLength;
  if (всего > ПРЕДЕЛ_БАЙТ) return false;
  try {
    // Превью у прежней записи бережём: модель та же, а рисовать его заново
    // дорого. Соседей тоже: модель могли открыть и одним файлом, без папки,
    // — прежний .mtl от этого не должен пропасть.
    const id = recentId(name, buffer.byteLength);
    const прежняя = await вТранзакции('readonly', (хр) => хр.get(id));
    const соседи = sidecars && sidecars.size ? [...sidecars] : (прежняя?.sidecars || []);
    const запись = {
      id,
      name,
      size: buffer.byteLength,
      opened: Date.now(),
      thumb: прежняя?.thumb || null,
      buffer,
      sidecars: соседи,
    };
    await вТранзакции('readwrite', (хр) => хр.put(запись));
    await подрезать();
    return true;
  } catch {
    return false;
  }
}

export async function removeRecent(id) {
  try { await вТранзакции('readwrite', (хр) => хр.delete(id)); } catch { /* нечего чистить */ }
}

export async function clearRecent() {
  try { await вТранзакции('readwrite', (хр) => хр.clear()); } catch { /* нечего чистить */ }
}

async function подрезать() {
  const список = await listRecent();
  const лишние = список.slice(СКОЛЬКО_ХРАНИМ);
  for (const з of лишние) await removeRecent(з.id);
}

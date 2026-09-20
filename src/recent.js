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

/** Список недавних, новые сверху. Без содержимого файлов — только карточки. */
export async function listRecent() {
  try {
    const всё = await вТранзакции('readonly', (хр) => хр.getAll());
    return (всё || [])
      .map(({ id, name, size, opened }) => ({ id, name, size, opened }))
      .sort((a, b) => b.opened - a.opened);
  } catch {
    return [];   // приватный режим или запрет хранилища — просто нет списка
  }
}

/** Достать файл целиком, чтобы открыть его заново. */
export async function getRecent(id) {
  try {
    const запись = await вТранзакции('readonly', (хр) => хр.get(id));
    return запись || null;
  } catch {
    return null;
  }
}

/** Запомнить открытый файл. Слишком крупные не храним — молча и честно. */
export async function addRecent(name, buffer) {
  if (!buffer || buffer.byteLength > ПРЕДЕЛ_БАЙТ) return false;
  try {
    const запись = {
      id: `${name}:${buffer.byteLength}`,
      name,
      size: buffer.byteLength,
      opened: Date.now(),
      buffer,
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

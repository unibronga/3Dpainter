/**
 * Зоны — именованные наборы граней меша: кристалл-кулон, светящийся камень,
 * любая деталь, которую игра красит и зажигает сама.
 *
 * Внутри программы зона ничего не меняет: красится как всё остальное, слои
 * общие. Работает она только в выгрузке: её грани уходят отдельным
 * примитивом меша с материалом, имя которого — имя зоны буква в букву. По
 * этому имени игра и находит деталь.
 *
 * Лицо — та же сущность «грани → материал» со своими правилами (выражения,
 * атласы, описание); грань может быть либо в лице, либо в одной зоне.
 *
 * Здесь — всё, что не знает про интерфейс.
 */

/** Имя зоны — имя материала в файле: латиница, цифры, «_». */
export const ZONE_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Годится ли имя. Возвращает ключ перевода причины или null.
 * @param {string[]} занятые имена, с которыми нельзя совпасть (без учёта регистра)
 */
export function zoneNameProblem(имя, занятые = []) {
  if (!имя) return 'zones.nameEmpty';
  if (!ZONE_NAME.test(имя)) return 'zones.nameBad';
  const низ = имя.toLowerCase();
  if (низ === 'face') return 'zones.nameFace';
  if (занятые.some((x) => x && x.toLowerCase() === низ)) return 'zones.nameTaken';
  return null;
}

/** Свободное имя вида «Zone_1», «Zone_2»… */
export function freeZoneName(занятые) {
  const низ = new Set(занятые.map((x) => String(x).toLowerCase()));
  for (let k = 1; ; k++) if (!низ.has(`zone_${k}`)) return `Zone_${k}`;
}

/** Сколько граней в наборе. */
export function countTris(tris) {
  let n = 0;
  for (let i = 0; i < tris.length; i++) if (tris[i]) n++;
  return n;
}

/** Убрать из набора грани другого набора. Возвращает, сколько ушло. */
export function subtractTris(tris, прочь) {
  let n = 0;
  for (let i = 0; i < tris.length; i++) if (tris[i] && прочь[i]) { tris[i] = 0; n++; }
  return n;
}

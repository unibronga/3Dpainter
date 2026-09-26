/**
 * Проект 3DPainter — рабочий файл `.3dpaint`, как PSD у Photoshop.
 *
 * Открыл — и всё на месте, как было при сохранении: модель, слои со всеми
 * картами, их свойства, положение модели, ракурс, материал и кисть. Этим он
 * отличается от выгрузки (GLB, OBJ, PNG), где слои сведены в одну картинку.
 *
 * Внутри — обычный zip, его можно распаковать и посмотреть:
 *
 *   project.json                  описание: всё, что не картинка
 *   model.glb                     геометрия с той развёрткой, по которой красили
 *   layers/<меш>/<слой>/rgba.bin  карты слоя — сырые байты, без потерь
 *                    …/rough.bin, metal.bin, opac.bin, mask.bin
 *
 * 🔴 Геометрия хранится вместе с развёрткой, а не исходный файл модели. Если
 * развёртку строила программа, а построитель в новой версии поменяется,
 * исходник дал бы другую развёртку, и слои легли бы мимо. Со своей
 * геометрией проект открывается так же в любой версии.
 *
 * Сырые байты, а не PNG: PNG хранит цвет «умноженным на прозрачность», и
 * там, где слой прозрачен, цвет терялся бы. Сжатие zip делает то же, что
 * сжатие PNG, — только без потерь для нашего случая.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';

export const PROJECT_EXT = '3dpaint';
const FORMAT = '3dpainter-project';
const VERSION = 1;

/** Проект ли это — по имени файла. */
export function isProject(имя) {
  return new RegExp(`\\.${PROJECT_EXT}$`, 'i').test(имя || '');
}

/**
 * Собрать проект.
 *
 * @param {object} о
 * @param {Uint8Array} о.modelGLB   геометрия в исходных координатах
 * @param {object} о.meta           всё, что не карты: имя, размер, поза…
 * @param {{name, triCount, size, activeIndex, layers}[]} о.meshes
 *        слои по мешам в порядке обхода модели
 * @param {string} о.app            версия программы
 * @returns {Uint8Array} содержимое файла
 */
export function packProject({ modelGLB, meta, meshes, app }) {
  const файлы = { 'model.glb': [modelGLB, { level: 0 }] };   // GLB уже плотный
  const описание = {
    format: FORMAT, version: VERSION, app, savedAt: new Date().toISOString(),
    ...meta,
    meshes: meshes.map((м, i) => ({
      index: i, name: м.name, triCount: м.triCount, size: м.size, activeIndex: м.activeIndex,
      layers: м.layers.map((L, j) => {
        const путь = `layers/${i}/${j}/`;
        const карты = { rgba: L.rgba, rough: L.rough, metal: L.metal, opac: L.opac };
        if (L.mask) карты.mask = L.mask;
        const имена = {};
        for (const [ключ, буфер] of Object.entries(карты)) {
          файлы[путь + ключ + '.bin'] = new Uint8Array(буфер.buffer, буфер.byteOffset, буфер.byteLength);
          имена[ключ] = путь + ключ + '.bin';
        }
        return { name: L.name, auto: L.auto, visible: L.visible, opacity: L.opacity, blend: L.blend, files: имена };
      }),
    })),
  };
  файлы['project.json'] = strToU8(JSON.stringify(описание, null, 1));
  return zipSync(файлы, { level: 6 });
}

/**
 * Разобрать проект.
 * @param {ArrayBuffer|Uint8Array} буфер
 * @returns {{meta: object, modelGLB: Uint8Array, file: (path: string) => Uint8Array|null}}
 */
export function unpackProject(буфер) {
  const файлы = unzipSync(буфер instanceof Uint8Array ? буфер : new Uint8Array(буфер));
  const описание = файлы['project.json'];
  if (!описание) throw new Error('нет project.json — это не проект 3DPainter');
  const meta = JSON.parse(strFromU8(описание));
  if (meta.format !== FORMAT) throw new Error('это не проект 3DPainter');
  if (meta.version > VERSION) throw new Error(`проект из более новой версии (формат ${meta.version})`);
  if (!файлы['model.glb']) throw new Error('в проекте нет модели');
  return { meta, modelGLB: файлы['model.glb'], file: (путь) => файлы[путь] || null };
}

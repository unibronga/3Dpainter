/**
 * Форматы 3D-файлов: чтение моделей и запись результата.
 *
 * Загрузчики подтягиваются по требованию (`import()`): их много, вместе они
 * весят больше самого инструмента, и платить за FBX тому, кто открывает GLB,
 * незачем.
 *
 * Покраска требует развёртки. Форматы делятся на два сорта: одни несут UV
 * (GLB, OBJ, FBX, DAE, 3MF), другие — только геометрию (STL, PLY, AMF).
 * Вторые откроются и покажутся, но красить на них нечего, и об этом честно
 * говорится вслух, а не выясняется первым мазком.
 */

import * as THREE from 'three';

/**
 * Что умеем читать. `uv: false` — формат в принципе не хранит развёртку.
 */
export const IMPORT_FORMATS = [
  { ext: ['glb', 'gltf'], name: 'glTF', uv: true },
  { ext: ['obj'],         name: 'OBJ',  uv: true },
  { ext: ['fbx'],         name: 'FBX',  uv: true },
  { ext: ['dae'],         name: 'Collada', uv: true },
  { ext: ['3mf'],         name: '3MF',  uv: true },
  { ext: ['wrl', 'vrml'], name: 'VRML', uv: true },
  { ext: ['stl'],         name: 'STL',  uv: false },
  { ext: ['ply'],         name: 'PLY',  uv: false },
  { ext: ['amf'],         name: 'AMF',  uv: false },
];

/** Строка для `<input type="file" accept="…">`. */
export function acceptAttribute() {
  // Спутники тоже в списке: иначе в диалоге их не выбрать вместе с моделью.
  return [...IMPORT_FORMATS.flatMap((f) => f.ext), ...SIDECAR_EXT]
    .map((e) => '.' + e).join(',');
}

/** Расширения, которые сами по себе не модель, но приходят с ней в комплекте. */
export const SIDECAR_EXT = ['mtl', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga'];

export function isSidecar(имяФайла) {
  return SIDECAR_EXT.includes(extensionOf(имяФайла));
}

/**
 * Библиотека материалов к .obj из файлов, которые дали вместе с моделью.
 *
 * Имя библиотеки берём из строки `mtllib`, но не доверяем ему слепо: в
 * выгрузках оно сплошь и рядом расходится с тем, что лежит в папке. Не нашли
 * по имени — берём любой .mtl из комплекта, он там обычно один.
 *
 * Картинки из `map_Kd` подставляются через подмену адреса: настоящих путей у
 * нас нет, файлы пришли из проводника, поэтому каждому имени сопоставляется
 * свой blob.
 *
 * @param {string} текстOBJ
 * @param {Map<string, ArrayBuffer>|null} спутники — имя файла в нижнем регистре → содержимое
 * @returns {Promise<object|null>} MaterialCreator или null
 */
async function читатьMTL(текстOBJ, спутники) {
  if (!спутники || !спутники.size) return null;

  const названо = /^mtllib\s+(.+)$/m.exec(текстOBJ)?.[1]?.trim().toLowerCase();
  const имя = (названо && спутники.has(названо))
    ? названо
    : [...спутники.keys()].find((k) => extensionOf(k) === 'mtl');
  if (!имя) return null;

  const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
  const THREE = await import('three');

  const ссылки = [];
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const ключ = url.split(/[\\/]/).pop().toLowerCase();
    const данные = спутники.get(ключ);
    if (!данные) return url;
    const ссылка = URL.createObjectURL(new Blob([данные]));
    ссылки.push(ссылка);
    return ссылка;
  });

  // Картинки из map_Kd грузятся сами по себе, после разбора. Покраска из
  // них переносится в слой сразу после открытия — значит, их надо дождаться,
  // иначе выпечка пройдёт по пустой текстуре.
  const готово = new Promise((ok) => {
    manager.onLoad = ok;
    manager.onError = () => {};
    setTimeout(ok, 8000);          // битая ссылка не должна держать открытие вечно
  });

  try {
    const creator = new MTLLoader(manager).parse(декодер.decode(спутники.get(имя)), '');
    creator.preload();
    const естьКарты = Object.values(creator.materials).some((m) => m.map || m.bumpMap || m.normalMap);
    if (естьКарты) await готово;
    // Адреса blob живут, пока картинки не прочитаны; отпускаем их следующим
    // кадром, когда загрузчик уже забрал содержимое.
    setTimeout(() => ссылки.forEach((u) => URL.revokeObjectURL(u)), 30000);
    return creator;
  } catch (err) {
    console.warn('[3DPainter] .mtl не прочёлся:', err);
    return null;
  }
}

export function extensionOf(имяФайла) {
  const m = /\.([a-z0-9]+)$/i.exec(имяФайла || '');
  return m ? m[1].toLowerCase() : '';
}

export function formatOf(имяФайла) {
  const ext = extensionOf(имяФайла);
  return IMPORT_FORMATS.find((f) => f.ext.includes(ext)) || null;
}

export function isSupported(имяФайла) {
  return !!formatOf(имяФайла);
}

/** Геометрия без материала — обернуть в меш, чтобы сцена была однородной. */
function мешИзГеометрии(geometry, имя = 'mesh') {
  geometry.computeVertexNormals?.();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 1 }));
  mesh.name = имя;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

const декодер = new TextDecoder();

/**
 * Прочитать файл модели. Возвращает `Object3D`, готовый для `setModel`.
 * @param {ArrayBuffer} буфер содержимое файла
 * @param {string} имя имя файла — по нему выбирается загрузчик
 */
export async function parseModel(буфер, имя, спутники = null) {
  const ext = extensionOf(имя);
  const основа = имя.replace(/\.[^.]+$/, '') || 'model';

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().parseAsync(буфер, '');
      return gltf.scene;
    }

    case 'obj': {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      const текст = декодер.decode(буфер);
      const loader = new OBJLoader();
      // Сам .obj материалов не несёт — они в соседнем .mtl. Если его дали
      // вместе с моделью, читаем: иначе цвета автора пропадут молча.
      const библиотека = await читатьMTL(текст, спутники);
      if (библиотека) loader.setMaterials(библиотека);
      const корень = loader.parse(текст);
      // Без библиотеки OBJLoader раздаёт всем белый материал по умолчанию.
      // Переносить его в покраску нельзя: это не цвет автора, а заглушка.
      корень.userData.materialsFromFile = !!библиотека;
      return корень;
    }

    case 'fbx': {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      return new FBXLoader().parse(буфер, '');
    }

    case 'dae': {
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      return new ColladaLoader().parse(декодер.decode(буфер), '').scene;
    }

    case '3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
      return new ThreeMFLoader().parse(буфер);
    }

    case 'wrl':
    case 'vrml': {
      const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
      return new VRMLLoader().parse(декодер.decode(буфер), '');
    }

    case 'stl': {
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      return мешИзГеометрии(new STLLoader().parse(буфер), основа);
    }

    case 'ply': {
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      return мешИзГеометрии(new PLYLoader().parse(буфер), основа);
    }

    case 'amf': {
      const { AMFLoader } = await import('three/addons/loaders/AMFLoader.js');
      return new AMFLoader().parse(буфер);
    }

    default:
      throw new Error(`.${ext}`);
  }
}

/* ── Запись результата ─────────────────────────────────────────── */

/**
 * Геометрия модели для проекта: сетка, развёртка, иерархия — без карт.
 *
 * Карты в проекте лежат слоями, в модель их класть незачем. Материал на
 * время выдачи один на меш и простой: с массивом материалов экспортёр режет
 * меш на части, и при открытии слои не нашли бы своих объектов. userData
 * прячем по той же причине, что и в кВыдаче: там кэш покраски на сотни МБ.
 *
 * @returns {Promise<Uint8Array>}
 */
export async function exportGeometryGLB(модель) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const прежние = new Map();
  const прежниеДанные = new Map();
  const простой = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  модель.traverse((o) => {
    if (o.userData && Object.keys(o.userData).length) { прежниеДанные.set(o, o.userData); o.userData = {}; }
    if (o.isMesh) { прежние.set(o, o.material); o.material = простой; }
  });
  try {
    const результат = await new GLTFExporter().parseAsync(модель, { binary: true });
    return new Uint8Array(результат);
  } finally {
    прежние.forEach((м, o) => { o.material = м; });
    прежниеДанные.forEach((д, o) => { o.userData = д; });
    простой.dispose();
  }
}

/**
 * Подготовить модель к выдаче — только на время экспорта.
 *
 * Делается две вещи. Первая: материалы подменяются на покрашенные, чтобы в
 * файл ушла работа, а не серая заготовка. Вторая: прячется служебный
 * `userData`.
 *
 * 🔴 Второе не украшение. Во `userData.paintCache` лежит кэш покраски —
 * оболочки граней, смежность, сетка ускорения, — а экспортёр glTF копирует
 * `userData` в `extras` как есть. Без этой уборки куб с одной текстурой
 * весил 314 МБ: гигабайты служебных массивов уезжали в файл текстом.
 *
 * Возвращает функцию отката: рабочую сцену трогать насовсем нельзя, иначе
 * сохранение молча ломало бы то, что человек видит на экране.
 */
function кВыдаче(модель, карты) {
  const прежние = new Map();
  const прежниеДанные = new Map();
  const созданные = [];

  модель.traverse((o) => {
    if (o.userData && Object.keys(o.userData).length) {
      прежниеДанные.set(o, o.userData);
      o.userData = {};
    }
    if (!o.isMesh) return;
    const набор = карты.get(o);
    if (!набор) return;

    прежние.set(o, o.material);

    // 🔴 flipY НЕ снимать. Холст покраски лежит верхом к v = 1 (обычная
    // ориентация three.js), а в glTF верх картинки — у v = 0. Экспортёр сам
    // переворачивает картинку текстуры с flipY; с flipY = false он писал её
    // как есть, и в любом просмотрщике — и при повторном открытии здесь же —
    // покраска ложилась не на те грани (замер: 41 803 пикселя мазка в
    // «чужом» кадре против 0 на тех же местах в нашем).
    const цвет = new THREE.CanvasTexture(набор.colorCanvas);
    цвет.colorSpace = THREE.SRGBColorSpace;
    созданные.push(цвет);

    const параметры = { map: цвет, roughness: 1, metalness: 0 };

    // Шероховатость в зелёном, металл в синем — стандартная упаковка glTF.
    if (набор.ormCanvas) {
      const orm = new THREE.CanvasTexture(набор.ormCanvas);   // flipY — см. выше
      созданные.push(orm);
      параметры.roughnessMap = orm;
      параметры.metalnessMap = orm;
      параметры.metalness = 1;
    }
    if (набор.transparent) { параметры.transparent = true; параметры.side = THREE.DoubleSide; }

    o.material = new THREE.MeshStandardMaterial(параметры);
    созданные.push(o.material);
  });

  return () => {
    прежние.forEach((м, o) => { o.material = м; });
    прежниеДанные.forEach((д, o) => { o.userData = д; });
    созданные.forEach((р) => р.dispose?.());
  };
}

/**
 * Модель вместе с покраской в glTF.
 * @param {boolean} двоичный true → .glb одним файлом, false → .gltf текстом
 * @returns {Promise<Blob>}
 */
export async function exportGLTF(модель, карты, двоичный = true) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const откатить = кВыдаче(модель, карты);

  try {
    const результат = await new GLTFExporter().parseAsync(модель, { binary: двоичный });
    return двоичный
      ? new Blob([результат], { type: 'model/gltf-binary' })
      : new Blob([JSON.stringify(результат)], { type: 'model/gltf+json' });
  } finally {
    откатить();
  }
}

/**
 * OBJ вместе с MTL. Экспортёр three пишет только геометрию, поэтому ссылку
 * на библиотеку материалов и сам .mtl собираем сами — без них редактор
 * откроет модель серой, и вся покраска окажется «потерянной».
 */
export async function exportOBJ(модель, карты, основа) {
  const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
  const откатить = кВыдаче(модель, карты);

  let текст;
  try { текст = new OBJExporter().parse(модель); } finally { откатить(); }

  // Своё имя материала: то, что подставляет экспортёр, к нашему .mtl
  // отношения не имеет.
  текст = текст.replace(/^usemtl .*$/gm, 'usemtl painted');
  if (!/^usemtl /m.test(текст)) текст = текст.replace(/^(o |g )/m, 'usemtl painted\n$1');
  текст = `mtllib ${основа}.mtl\n${текст}`;

  const mtl = [
    '# Painted material',
    'newmtl painted',
    'Ka 1.000 1.000 1.000',
    'Kd 1.000 1.000 1.000',
    'Ks 0.000 0.000 0.000',
    'd 1.0',
    'illum 2',
    `map_Kd ${основа}.png`,
    '',
  ].join('\n');

  return {
    obj: new Blob([текст], { type: 'model/obj' }),
    mtl: new Blob([mtl], { type: 'model/mtl' }),
  };
}

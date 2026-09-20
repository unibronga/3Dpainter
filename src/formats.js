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
  return IMPORT_FORMATS.flatMap((f) => f.ext).map((e) => '.' + e).join(',');
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
export async function parseModel(буфер, имя) {
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
      return new OBJLoader().parse(декодер.decode(буфер));
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

    const цвет = new THREE.CanvasTexture(набор.colorCanvas);
    цвет.colorSpace = THREE.SRGBColorSpace;
    цвет.flipY = false;
    созданные.push(цвет);

    const параметры = { map: цвет, roughness: 1, metalness: 0 };

    // Шероховатость в зелёном, металл в синем — стандартная упаковка glTF.
    if (набор.ormCanvas) {
      const orm = new THREE.CanvasTexture(набор.ormCanvas);
      orm.flipY = false;
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
    '# Материал покраски',
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

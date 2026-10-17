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
    const текстMTL = декодер.decode(спутники.get(имя));
    const creator = new MTLLoader(manager).parse(текстMTL, '');
    creator.preload();
    // 🔴 Blender пишет в Kd линейный цвет — те же числа, что в baseColorFactor
    // его GLB. MTLLoader читает Kd как sRGB, и сундук из 3DModelist выходил
    // тёмным: дерево 0.337 давало 86 из 255 вместо 158. Узнаём Blender по
    // шапке файла; у прочих Kd остаётся sRGB, как его понимает three.js.
    if (/^#\s*Blender\b/m.test(текстMTL)) {
      for (const [название, m] of Object.entries(creator.materials)) {
        const kd = creator.materialsInfo[название]?.kd;
        if (kd && m.color) m.color.setRGB(+kd[0], +kd[1], +kd[2], THREE.LinearSRGBColorSpace);
      }
    }
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
      const loader = new GLTFLoader();
      loader.register(читательВариантов);
      const gltf = await loader.parseAsync(буфер, '');
      // Клипы загрузчик отдаёт рядом со сценой, а не в ней. Не положить их
      // в модель — при сохранении они пропадут: экспортёру нечего передать.
      gltf.scene.animations = gltf.animations;
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
  const простые = [];
  модель.traverse((o) => {
    const данные = o.userData;
    if (данные && Object.keys(данные).length) { прежниеДанные.set(o, данные); o.userData = {}; }
    if (!o.isMesh) return;
    // Простой материал свой у каждого меша — чтобы нести имя исходного:
    // из проекта модель потом снова уходит в GLB, и имя не должно потеряться.
    const простой = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    простой.name = данные?.sourceMaterialName || '';
    простые.push(простой);
    прежние.set(o, o.material);
    o.material = простой;
  });
  try {
    const результат = await new GLTFExporter().parseAsync(модель, { binary: true, animations: модель.animations || [] });
    return new Uint8Array(результат);
  } finally {
    прежние.forEach((м, o) => { o.material = м; });
    прежниеДанные.forEach((д, o) => { o.userData = д; });
    простые.forEach((м) => м.dispose());
  }
}

/* ── Варианты покраски: KHR_materials_variants ───────────────────
 *
 * Стандарт glTF для «одна модель — несколько обличий»: у примитива меша
 * несколько материалов, каждый привязан к варианту по номеру, список имён
 * вариантов лежит в корне файла. Blender читает его панелью glTF Variants.
 * three.js сам его не пишет и не читает — отсюда два расширения ниже.
 */
const ВАРИАНТЫ = 'KHR_materials_variants';

/**
 * Чтение: материалы вариантов — в `userData.variantMaterials` меша (по номеру
 * варианта), имена — в `userData.variants` сцены. Дальше их карты ложатся
 * слоями вариантов (`main.js`, bakeSourceVariants).
 */
function читательВариантов(parser) {
  return {
    name: ВАРИАНТЫ,
    async afterRoot(result) {
      const корень = parser.json.extensions?.[ВАРИАНТЫ];
      if (!корень?.variants?.length) return;
      const ждём = [];
      result.scene.traverse((o) => {
        if (!o.isMesh) return;
        const связь = parser.associations.get(o);
        if (связь?.meshes == null) return;
        const примитив = parser.json.meshes[связь.meshes]?.primitives?.[связь.primitives ?? 0];
        const привязки = примитив?.extensions?.[ВАРИАНТЫ]?.mappings;
        if (!привязки) return;
        ждём.push((async () => {
          const список = new Array(корень.variants.length).fill(null);
          for (const п of привязки) {
            const материал = await parser.getDependency('material', п.material);
            for (const v of п.variants) список[v] = материал;
          }
          o.userData.variantMaterials = список;
        })());
      });
      await Promise.all(ждём);
      result.scene.userData.variants = корень.variants.map((v, i) => v.name || String(i + 1));
    },
  };
}

/**
 * Запись: у меша с вариантами материал по умолчанию — включённого варианта,
 * остальные дописываются в файл, пока экспортёр пишет материал по умолчанию
 * (этот шаг он дожидается, `writeMesh` — нет).
 *
 * @param {string[]} имена имена вариантов по порядку
 * @param {Map<THREE.Material, THREE.Material[]>} наборы материал по умолчанию → материалы вариантов
 */
function писательВариантов(имена, наборы) {
  return (writer) => {
    const номера = new Map();    // материал по умолчанию → номера материалов вариантов в файле
    return {
      name: ВАРИАНТЫ,
      async writeMaterialAsync(material) {
        const набор = наборы.get(material);
        if (!набор) return;
        const список = [];
        for (const м of набор) список.push(м === material ? null : await writer.processMaterialAsync(м));
        номера.set(material, список);
      },
      writeMesh(mesh, meshDef) {
        // Меш с зонами — несколько материалов, примитив на группу по порядку;
        // у каждого примитива свои материалы вариантов.
        const группы = Array.isArray(mesh.material) ? mesh.geometry.groups : null;
        let было = false;
        meshDef.primitives.forEach((примитив, i) => {
          const материал = группы ? mesh.material[группы[i]?.materialIndex] : mesh.material;
          const список = номера.get(материал);
          if (!список) return;
          // Один материал на несколько вариантов — одной привязкой.
          const поМатериалу = new Map();
          список.forEach((номер, v) => {
            const м = номер ?? примитив.material;
            if (!поМатериалу.has(м)) поМатериалу.set(м, []);
            поМатериалу.get(м).push(v);
          });
          примитив.extensions = { ...(примитив.extensions || {}),
            [ВАРИАНТЫ]: { mappings: [...поМатериалу].map(([material, variants]) => ({ material, variants })) } };
          было = true;
        });
        if (было) writer.extensionsUsed[ВАРИАНТЫ] = true;
      },
      afterParse() {
        if (!номера.size) return;
        writer.json.extensions = writer.json.extensions || {};
        writer.json.extensions[ВАРИАНТЫ] = { variants: имена.map((name) => ({ name })) };
      },
    };
  };
}

/**
 * Имя материала варианта. Первый вариант носит имя исходного материала —
 * «Leaf» остаётся «Leaf», — остальные получают имя варианта через «_».
 * Безымянный исходник — материалы зовутся именами вариантов.
 */
export function имяМатериалаВарианта(исходное, вариант, номер) {
  if (!исходное) return вариант;
  return номер === 0 ? исходное : `${исходное}_${вариант}`;
}

/**
 * Геометрия на время выдачи: сначала грани тела, потом грани каждой части
 * (лицо, зоны) — группами, экспортёр сделает из них примитивы. Рабочая
 * геометрия не трогается — порядок граней держит слои и кэш.
 *
 * 🔴 Вершины не размножаются. У индексированной геометрии переставляется
 * только индекс: атрибуты общие, примитивы ссылаются на одни и те же
 * вершины, и число вершин в файле — как в исходнике (раньше лицо уходило
 * через toNonIndexed: у дракона 3354 вершины становились 10 785). У
 * неиндексированной переставляются тройки вершин — их число и так 3·граней.
 * Скин и морфы едут вместе с атрибутами: модель с костями остаётся целой.
 *
 * @param {Uint8Array[]} части по номерам треугольников: 1 — грань части;
 *        грань берёт первая часть, в которую попала
 * @returns {{ geometry, кто: number[] }} кто — по группам: -1 тело, k — часть
 */
function разделитьНаЧасти(geo, части) {
  const n = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  const чья = new Int16Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < части.length; k++) if (части[k][t]) { чья[t] = k; break; }
  }
  const порядок = [];
  const out = new THREE.BufferGeometry();
  const кто = [];
  for (let k = -1; k < части.length; k++) {
    const начало = порядок.length;
    for (let t = 0; t < n; t++) if (чья[t] === k) порядок.push(t);
    if (порядок.length === начало) continue;          // пустая часть — без примитива
    out.addGroup(начало * 3, (порядок.length - начало) * 3, кто.length);
    кто.push(k);
  }

  if (geo.index) {
    const src = geo.index.array;
    const idx = new (src.constructor)(n * 3);
    порядок.forEach((t, i) => { idx[i * 3] = src[t * 3]; idx[i * 3 + 1] = src[t * 3 + 1]; idx[i * 3 + 2] = src[t * 3 + 2]; });
    for (const [имя, a] of Object.entries(geo.attributes)) out.setAttribute(имя, a);
    for (const [имя, список] of Object.entries(geo.morphAttributes)) out.morphAttributes[имя] = список;
    out.setIndex(new THREE.BufferAttribute(idx, 1));
  } else {
    const переставить = (attr) => {
      const a = attr.isInterleavedBufferAttribute ? attr.clone() : attr;   // clone() снимает чередование
      const k = a.itemSize;
      const arr = new a.array.constructor(n * 3 * k);
      порядок.forEach((t, i) => arr.set(a.array.subarray(t * 3 * k, (t + 1) * 3 * k), i * 3 * k));
      return new THREE.BufferAttribute(arr, k, a.normalized);
    };
    for (const [имя, a] of Object.entries(geo.attributes)) out.setAttribute(имя, переставить(a));
    for (const [имя, список] of Object.entries(geo.morphAttributes)) out.morphAttributes[имя] = список.map(переставить);
  }
  out.morphTargetsRelative = geo.morphTargetsRelative;
  return { geometry: out, кто };
}

/** Сколько граней в части. */
function граней(tris) {
  let n = 0;
  for (let i = 0; i < tris.length; i++) if (tris[i]) n++;
  return n;
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
  const наборы = new Map();     // материал по умолчанию → материалы вариантов
  let именаВариантов = null;
  const прежниеГеометрии = new Map();
  const разметка = new Map();   // меш с частями → группы по порядку: { name (null — тело), count }

  модель.traverse((o) => {
    const данные = o.userData;
    if (данные && Object.keys(данные).length) {
      прежниеДанные.set(o, данные);
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
    const материал = (холстЦвета, холстМатериала, прозрачный, имя) => {
      const цвет = new THREE.CanvasTexture(холстЦвета);
      цвет.colorSpace = THREE.SRGBColorSpace;
      созданные.push(цвет);

      const параметры = { map: цвет, roughness: 1, metalness: 0 };

      // Шероховатость в зелёном, металл в синем — стандартная упаковка glTF.
      if (холстМатериала) {
        const orm = new THREE.CanvasTexture(холстМатериала);   // flipY — см. выше
        созданные.push(orm);
        параметры.roughnessMap = orm;
        параметры.metalnessMap = orm;
        параметры.metalness = 1;
      }
      if (прозрачный) { параметры.transparent = true; параметры.side = THREE.DoubleSide; }

      const м = new THREE.MeshStandardMaterial(параметры);
      // Имя материала — из файла: в Blender по нему узнают, что это за материал.
      м.name = имя;
      созданные.push(м);
      return м;
    };

    const исходное = данные?.sourceMaterialName || '';
    // Лицо целым мешем (взято по материалу) — меш просто зовётся «Face».
    const имяТела = набор.face?.whole ? 'Face' : исходное;

    // Материал по имени: один — или, если у меша развёртки-варианты, набор
    // материалов вариантов с этим именем в основе.
    const сделать = (имя) => {
      if (!набор.variants?.length) return материал(набор.colorCanvas, набор.ormCanvas, набор.transparent, имя);
      const список = набор.variants.map((v, i) =>
        материал(v.color, v.orm, v.transparent, имяМатериалаВарианта(имя, v.name, i)));
      const м = список[набор.activeVariant] || список[0];
      наборы.set(м, список);
      именаВариантов = набор.variants.map((v) => v.name);
      return м;
    };

    // Части меша — лицо (выделенные грани) и зоны: каждая уходит своим
    // примитивом с материалом своего имени. Развёртка та же, текстура та же
    // картинка: игра находит деталь по имени материала.
    const части = [];
    if (набор.face && !набор.face.whole) части.push({ name: 'Face', tris: набор.face.tris });
    for (const з of набор.zones || []) if (граней(з.tris)) части.push(з);
    if (!части.length) { o.material = сделать(имяТела); return; }

    const { geometry, кто } = разделитьНаЧасти(o.geometry, части.map((ч) => ч.tris));
    const материалы = кто.map((k) => сделать(k < 0 ? имяТела : части[k].name));
    // Зона на весь меш (кулон отдельным мешем) — делить нечего, только имя.
    if (кто.length === 1) { o.material = материалы[0]; return; }
    // Временную геометрию не освобождаем: её атрибуты — те же объекты, что у
    // рабочей, и dispose() у отрисованной снял бы их буферы с видеокарты.
    // Экспортёр её не рисует; уйдёт со сборщиком мусора.
    прежниеГеометрии.set(o, o.geometry);
    o.geometry = geometry;
    o.material = материалы;
    разметка.set(o, кто.map((k, i) => ({ name: k < 0 ? null : части[k].name, count: geometry.groups[i].count / 3 })));
  });

  const откатить = () => {
    прежниеГеометрии.forEach((г, o) => { o.geometry = г; });
    прежние.forEach((м, o) => { o.material = м; });
    прежниеДанные.forEach((д, o) => { o.userData = д; });
    созданные.forEach((р) => р.dispose?.());
  };
  return { откатить, разметка, варианты: наборы.size ? писательВариантов(именаВариантов, наборы) : null };
}

/**
 * Модель вместе с покраской в glTF.
 * @param {boolean} двоичный true → .glb одним файлом, false → .gltf текстом
 * @returns {Promise<Blob>}
 */
export async function exportGLTF(модель, карты, двоичный = true) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const { откатить, варианты } = кВыдаче(модель, карты);

  try {
    const экспортёр = new GLTFExporter();
    if (варианты) экспортёр.register(варианты);
    // Клипы — те, с которыми модель открылась: скелет и скин экспортёр
    // пишет сам, а дорожки анимации берёт только из этой опции.
    const результат = await экспортёр.parseAsync(модель, { binary: двоичный, animations: модель.animations || [] });
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
  const { откатить, разметка } = кВыдаче(модель, карты);   // OBJ — только включённый вариант

  // Что экспортёр пишет объектом «o …» — в его же порядке обхода: по этому
  // списку строки граней раскладываются на группы материалов.
  const объекты = [];
  модель.traverse((o) => { if (o.isMesh || o.isLine || o.isPoints) объекты.push(o); });
  let текст;
  try { текст = new OBJExporter().parse(модель); } finally { откатить(); }

  // Свои имена материалов: то, что подставляет экспортёр, к нашему .mtl
  // отношения не имеет. Тело — «painted»; лицо и зоны — своими именами
  // группами граней: в Blender это слоты материалов с теми же именами.
  const зоны = new Set();
  const строки = [];
  let номер = -1, группы = null, граньВГруппе = 0, группа = 0;
  const имя = (г) => г.name || 'painted';
  for (const строка of текст.split('\n')) {
    if (строка.startsWith('usemtl ')) continue;
    if (строка.startsWith('o ')) {
      номер += 1;
      const о = объекты[номер];
      группы = о?.isMesh ? (разметка.get(о) || [{ name: null, count: Infinity }]) : null;
      граньВГруппе = 0; группа = 0;
      строки.push(строка);
      continue;
    }
    if (группы && строка.startsWith('f ')) {
      while (группа < группы.length - 1 && граньВГруппе >= группы[группа].count) { группа += 1; граньВГруппе = 0; }
      if (граньВГруппе === 0) {
        строки.push('usemtl ' + имя(группы[группа]));
        if (группы[группа].name) зоны.add(группы[группа].name);
      }
      граньВГруппе += 1;
    }
    строки.push(строка);
  }
  текст = `mtllib ${основа}.mtl\n${строки.join('\n')}`;

  const материалMTL = (название) => [
    `newmtl ${название}`,
    'Ka 1.000 1.000 1.000',
    'Kd 1.000 1.000 1.000',
    'Ks 0.000 0.000 0.000',
    'd 1.0',
    'illum 2',
    `map_Kd ${основа}.png`,
    '',
  ];
  const mtl = ['# Painted material', ...материалMTL('painted'), ...[...зоны].flatMap(материалMTL)].join('\n');

  return {
    obj: new Blob([текст], { type: 'model/obj' }),
    mtl: new Blob([mtl], { type: 'model/mtl' }),
  };
}

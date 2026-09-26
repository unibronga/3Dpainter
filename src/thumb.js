/**
 * Превью модели для списка недавних.
 *
 * Две дороги, и обе нужны:
 *
 * 1. `снятьСВьюпорта` — модель уже открыта и скадрирована, снимок обходится
 *    почти даром. Работает потому, что у рендерера включён
 *    `preserveDrawingBuffer`: содержимое холста доступно и после кадра.
 * 2. `нарисоватьПревью` — запись в недавних осталась от прошлых версий, где
 *    снимков не делали. Поднимаем маленький рендерер на один кадр. Дорого,
 *    но случается ровно один раз на модель: снимок тут же уходит в базу.
 *
 * Снимок держим маленьким: он лежит в IndexedDB рядом с файлом, и десяток
 * тяжёлых картинок съел бы квоту, ради которой файлы и ограничены.
 */

const СТОРОНА = 320;

/** Картинка в data-URL: webp, где он есть, иначе png. */
function вКартинку(холст) {
  const webp = холст.toDataURL('image/webp', 0.82);
  return webp.startsWith('data:image/webp') ? webp : холст.toDataURL('image/png');
}

/**
 * Снимок с живого вьюпорта, вписанный в квадрат.
 * @param {HTMLCanvasElement} холстВьюпорта
 * @returns {string|null} data-URL
 */
export function снятьСВьюпорта(холстВьюпорта) {
  try {
    if (!холстВьюпорта?.width || !холстВьюпорта?.height) return null;
    const к = document.createElement('canvas');
    к.width = к.height = СТОРОНА;
    const ctx = к.getContext('2d');
    ctx.fillStyle = '#1b1d21';
    ctx.fillRect(0, 0, СТОРОНА, СТОРОНА);

    // Берём из кадра центральный квадрат: модель скадрирована по центру,
    // а по краям вьюпорта только сетка и пустота.
    const сторона = Math.min(холстВьюпорта.width, холстВьюпорта.height);
    const sx = (холстВьюпорта.width - сторона) / 2;
    const sy = (холстВьюпорта.height - сторона) / 2;
    ctx.drawImage(холстВьюпорта, sx, sy, сторона, сторона, 0, 0, СТОРОНА, СТОРОНА);
    return вКартинку(к);
  } catch {
    return null;   // холст «запятнан» или контекст потерян — обойдёмся без превью
  }
}

/**
 * Отрисовать превью по содержимому файла — для записей без снимка.
 *
 * Своя сцена и свой рендерер: главный вьюпорт занят работой человека, и
 * трогать его ради картинки нельзя.
 *
 * @param {ArrayBuffer} буфер
 * @param {string} имя
 * @param {Map<string, ArrayBuffer>} [соседи] .mtl и текстуры — без них OBJ белый
 * @returns {Promise<string|null>} data-URL
 */
export async function нарисоватьПревью(буфер, имя, соседи = null) {
  let renderer = null;
  try {
    const THREE = await import('three');
    const { parseModel } = await import('./formats.js');
    const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');

    const модель = await parseModel(буфер.slice(0), имя, соседи && соседи.size ? соседи : null);
    if (!модель) return null;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(СТОРОНА, СТОРОНА, false);
    renderer.setClearColor(0x1b1d21, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    // Свет и окружение те же, что во вьюпорте: превью не должно врать про
    // модель, которую человек сейчас откроет.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;
    pmrem.dispose();
    scene.add(new THREE.AmbientLight(0xffffff, 1.05));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x60646c, 0.8));
    const солнце = new THREE.DirectionalLight(0xffffff, 1.1);
    солнце.position.set(1, 1.4, 0.8);
    scene.add(солнце);
    scene.add(модель);

    const box = new THREE.Box3().setFromObject(модель);
    if (box.isEmpty()) return null;
    const размер = box.getSize(new THREE.Vector3());
    const центр = box.getCenter(new THREE.Vector3());
    const габарит = Math.max(размер.x, размер.y, размер.z) || 1;

    const camera = new THREE.PerspectiveCamera(45, 1, габарит / 500, габарит * 20);
    const дистанция = (габарит / 2) / Math.tan((45 * Math.PI) / 360) * 1.9;
    camera.position.copy(центр).addScaledVector(new THREE.Vector3(0.75, 0.5, 1).normalize(), дистанция);
    camera.lookAt(центр);

    renderer.render(scene, camera);
    const картинка = вКартинку(renderer.domElement);

    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m?.dispose());
    });
    return картинка;
  } catch (err) {
    console.warn('[3DPainter] превью не нарисовалось:', err);
    return null;
  } finally {
    // Контекстов WebGL у браузера считанные единицы: не освободив рендерер,
    // после нескольких превью перестал бы работать сам вьюпорт.
    renderer?.dispose();
    renderer?.forceContextLoss?.();
  }
}

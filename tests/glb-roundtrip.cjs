/**
 * Проверка: GLB с арматурой, двумя клипами и материалом «Leaf» проходит
 * через 3DPainter целым.
 *
 *   npm test        (собирает страницу и запускает эту проверку в Electron)
 *
 * Путь тот же, что у человека: открыть файл, покрасить верх стебля заливкой,
 * сохранить GLB (`__paint.exportGLB` — «Сохранить как ▸ GLB» без окна),
 * открыть результат снова. Сверяется:
 *   - клипы на месте — те же имена и длительность, дорожки попадают в кости,
 *     значения в дорожках меняются (модель двигается);
 *   - меш остался скинованным, костей столько же;
 *   - материал называется «Leaf»;
 *   - покраска на месте: верх синий, низ — каким был до покраски.
 * Затем варианты покраски: общий низ и свой верх у трёх вариантов — в работе,
 * после GLB (`KHR_materials_variants`) и после проекта `.3dpaint`.
 * Если установлен Blender, оба файла открываются в нём (`blender-check.py`).
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'leaf-rig.glb');
const INDEX = path.join(ROOT, 'dist', 'index.html');
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3dpainter-test-'));
app.setPath('userData', path.join(tmp, 'user'));

const провалы = [];
let js = null;                 // выполнить код на странице — заводится в main
const синий = (c) => c && c[2] > 150 && c[0] < 90;
const зелёный = (c) => c && c[1] > c[0] + 40 && c[1] > c[2] + 40;
const близко = (a, b) => a && b && a.every((v, k) => Math.abs(v - b[k]) <= 6);
function проверить(условие, что) {
  console.log(`${условие ? '  ok ' : '  FAIL'} ${что}`);
  if (!условие) провалы.push(что);
}

/** Сведения о модели на странице: клипы, меши, материалы, покраска. */
const ОПИСЬ = `(() => {
  const P = window.__paint;
  const m = P.viewport.model;
  const имена = new Set();
  m.traverse((o) => { if (o.name) имена.add(o.name); });
  const клипы = (m.animations || []).map((c) => ({
    name: c.name,
    duration: c.duration,
    tracks: c.tracks.length,
    // Дорожка «Tip.quaternion» должна найти узел «Tip» в модели.
    unbound: c.tracks.filter((t) => !имена.has(t.name.slice(0, t.name.lastIndexOf('.')))).map((t) => t.name),
    // Движется ли хоть что-то: значения дорожки не все одинаковые.
    moving: c.tracks.some((t) => { const v = t.values, n = v.length / t.times.length;
      for (let i = n; i < v.length; i++) if (Math.abs(v[i] - v[i % n]) > 1e-4) return true; return false; }),
  }));
  const меши = P.viewport.paintables.map(({ mesh, cache }) => {
    const target = P.targets.get(mesh);
    // Цвет у верхних и нижних треугольников — по текселю под центром.
    const { pos, uv, idx, triCount } = cache;
    const S = target.size, px = target.composite;
    const цвет = (t) => {
      const u = (uv[idx[t*3]*2] + uv[idx[t*3+1]*2] + uv[idx[t*3+2]*2]) / 3;
      const v = (uv[idx[t*3]*2+1] + uv[idx[t*3+1]*2+1] + uv[idx[t*3+2]*2+1]) / 3;
      const x = Math.min(S-1, Math.max(0, Math.floor(u*S))), y = Math.min(S-1, Math.max(0, Math.floor((1-v)*S)));
      const o = (y*S + x) * 4; return [px[o], px[o+1], px[o+2]];
    };
    const e = mesh.matrixWorld.elements;
    const высота = (t) => { let s = 0; for (let k = 0; k < 3; k++) { const i = idx[t*3+k]*3;
      s += e[1]*pos[i] + e[5]*pos[i+1] + e[9]*pos[i+2] + e[13]; } return s / 3; };
    const ys = Array.from({ length: triCount }, (_, t) => высота(t));
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const верх = [], низ = [];
    ys.forEach((y, t) => { if (y > lo + 0.85*(hi-lo)) верх.push(цвет(t)); else if (y < lo + 0.15*(hi-lo)) низ.push(цвет(t)); });
    const среднее = (a) => a.length ? [0,1,2].map((k) => Math.round(a.reduce((s, c) => s + c[k], 0) / a.length)) : null;
    return {
      name: mesh.name, skinned: !!mesh.isSkinnedMesh, bones: mesh.skeleton ? mesh.skeleton.bones.length : 0,
      material: mesh.userData.sourceMaterialName || null, lo, hi, top: среднее(верх), bottom: среднее(низ),
    };
  });
  return { clips: клипы, meshes: меши };
})()`;

async function main() {
  if (!fs.existsSync(INDEX)) throw new Error('нет dist/index.html — сначала npm run build');

  const win = new BrowserWindow({
    show: false,
    width: 1400, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  await win.loadFile(INDEX);
  js = (код) => win.webContents.executeJavaScript(код);
  await js(`new Promise((r) => { const ждать = () => window.__paint ? r() : setTimeout(ждать, 50); ждать(); })`);
  const ошибкиЗапуска = await js('window.__paint.bootErrors');
  проверить(!ошибкиЗапуска.length, `программа поднялась без ошибок ${ошибкиЗапуска.length ? JSON.stringify(ошибкиЗапуска) : ''}`);

  // 1. Открыть исходник.
  const исходник = fs.readFileSync(FIXTURE).toString('base64');
  const открыт = await js(`(async () => {
    const b = Uint8Array.from(atob('${исходник}'), (c) => c.charCodeAt(0)).buffer;
    return window.__paint.openBuffer(b, 'leaf-rig.glb');
  })()`);
  проверить(открыт === true, 'исходный GLB открылся');
  const до = await js(ОПИСЬ);
  console.log('  исходник:', JSON.stringify(до.clips.map((c) => [c.name, +c.duration.toFixed(4)])), до.meshes.map((m) => m.material));

  // 2. Покрасить верхнюю половину стебля синим — заливкой, как ИИ или человек.
  const m0 = до.meshes[0];
  const заливка = await js(`window.__mcp.call('fill', { target: { mesh: 0, above: ${(m0.lo + m0.hi) / 2} }, color: '#2050e0' })`);
  console.log('  заливка:', JSON.stringify(заливка).slice(0, 160));

  // 3. Сохранить GLB и открыть результат снова.
  const выдача = await js(`(async () => {
    const blob = await window.__paint.exportGLB();
    const b = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  const файл = path.join(tmp, 'leaf-rig-painted.glb');
  fs.writeFileSync(файл, Buffer.from(выдача, 'base64'));
  console.log('  сохранено:', файл, fs.statSync(файл).size, 'байт');

  const снова = await js(`(async () => {
    const b = Uint8Array.from(atob('${выдача}'), (c) => c.charCodeAt(0)).buffer;
    return window.__paint.openBuffer(b, 'leaf-rig-painted.glb');
  })()`);
  проверить(снова === true, 'сохранённый GLB открылся в 3DPainter');
  const после = await js(ОПИСЬ);

  // 4. Сверка.
  for (const c of до.clips) {
    const п = после.clips.find((x) => x.name === c.name);
    проверить(!!п, `клип «${c.name}» на месте`);
    if (!п) continue;
    проверить(Math.abs(п.duration - c.duration) < 1e-3, `«${c.name}»: длительность ${c.duration.toFixed(4)} → ${п.duration.toFixed(4)} с`);
    проверить(!п.unbound.length, `«${c.name}»: дорожки находят свои узлы ${п.unbound.length ? п.unbound.join(', ') : ''}`);
    проверить(п.moving, `«${c.name}»: модель двигается`);
  }
  проверить(до.clips.length === 2 && после.clips.length === 2, `клипов два: было ${до.clips.length}, стало ${после.clips.length}`);
  const м = после.meshes[0];
  проверить(м.skinned && м.bones === m0.bones && м.bones === 2, `меш скинованный, костей ${м.bones}`);
  проверить(м.material === 'Leaf', `материал называется «${м.material}»`);
  проверить(синий(м.top), `покраска на месте: верх ${JSON.stringify(м.top)}`);
  проверить(!синий(м.bottom) && близко(м.bottom, m0.bottom), `низ не тронут: был ${JSON.stringify(m0.bottom)}, стал ${JSON.stringify(м.bottom)}`);

  // 5. Blender — если есть.
  blender(файл);

  // 6. Варианты покраски: общий низ зелёный, верх у вариантов свой.
  console.log('\nВарианты покраски:');
  await открыть(исходник, 'leaf-rig.glb');
  const середина = (m0.lo + m0.hi) / 2;
  const вариантыДо = await js(`(async () => {
    const P = window.__paint;
    await window.__mcp.call('fill', { target: { mesh: 0, below: ${середина} }, color: '#30a040' });
    P.addVariant();
    await window.__mcp.call('fill', { target: { mesh: 0, above: ${середина} }, color: '#2050e0', layer: P.state.activeLayer });
    P.addVariant();
    await window.__mcp.call('fill', { target: { mesh: 0, above: ${середина} }, color: '#e04020', layer: P.state.activeLayer });
    ['Base', 'Blue', 'Red'].forEach((n, i) => { P.state.variants[i].name = n; P.state.variants[i].auto = null; });
    P.включитьВариант(2);
    return P.state.variants.length;
  })()`);
  проверить(вариантыДо === 3, `заведено вариантов: ${вариантыДо}`);

  /** Верх и низ в каждом варианте — включая по очереди, как человек щелчком. */
  const поВариантам = () => js(`(() => {
    const P = window.__paint, out = { names: P.state.variants.map((v) => v.name), active: P.state.activeVariant };
    const был = P.state.activeVariant;
    for (const v of P.state.variants) { P.включитьВариант(v.id); out[v.name] = ${ОПИСЬ}.meshes[0]; }
    P.включитьВариант(был);
    out.clips = P.viewport.model.animations.map((c) => c.name);
    return out;
  })()`);
  const ждём = { Base: (c) => близко(c, m0.bottom), Blue: синий, Red: (c) => c && c[0] > 150 && c[2] < 90 };
  const сверить = (о, где) => {
    проверить(JSON.stringify(о.names) === '["Base","Blue","Red"]', `${где}: варианты ${JSON.stringify(о.names)}`);
    проверить(о.active === 2, `${где}: включён вариант ${о.active} (сохраняли со вторым)`);
    for (const [имя, годен] of Object.entries(ждём)) {
      const м = о[имя];
      проверить(м && годен(м.top) && зелёный(м.bottom), `${где}: «${имя}» — верх ${JSON.stringify(м?.top)}, низ ${JSON.stringify(м?.bottom)}`);
    }
    проверить(о.clips.length === 2, `${где}: клипы на месте (${о.clips.join(', ')})`);
  };
  сверить(await поВариантам(), 'в работе');

  const выдачаВ = await js(`(async () => {
    const b = new Uint8Array(await (await window.__paint.exportGLB()).arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  const файлВ = path.join(tmp, 'leaf-rig-variants.glb');
  fs.writeFileSync(файлВ, Buffer.from(выдачаВ, 'base64'));
  проверить(await открыть(выдачаВ, 'leaf-rig-variants.glb'), 'GLB с вариантами открылся снова');
  сверить(await поВариантам(), 'из GLB');
  const имяМ = await js(`window.__paint.viewport.paintables[0].mesh.userData.sourceMaterialName`);
  проверить(имяМ === 'Leaf', `из GLB: исходное имя материала «${имяМ}»`);

  const проект = await js(`(async () => {
    const b = await window.__paint.projectBytes();
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  проверить(await открыть(проект, 'leaf.3dpaint'), 'проект с вариантами открылся');
  сверить(await поВариантам(), 'из проекта');

  blender(файлВ, ['--variants', 'Base,Blue,Red']);
}

/** Открыть файл из base64 тем же путём, что и человек. */
function открыть(b64, имя) {
  return js(`(async () => {
    const b = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0)).buffer;
    return window.__paint.openBuffer(b, '${имя}');
  })()`);
}

/** Сверка в Blender, если он установлен. */
function blender(файл, доп = []) {
  if (!fs.existsSync(BLENDER)) {
    console.log('  Blender не найден — проверка в нём пропущена (путь задаётся BLENDER=...)');
    return;
  }
  const r = spawnSync(BLENDER, ['-b', '--factory-startup', '-P', path.join(__dirname, 'blender-check.py'), '--', файл, ...доп],
    { encoding: 'utf8', timeout: 120000 });
  const строки = (r.stdout || '').split('\n').filter((s) => s.startsWith('  ok ') || s.startsWith('  FAIL'));
  console.log('  Blender:');
  строки.forEach((s) => console.log('  ' + s));
  строки.filter((s) => s.startsWith('  FAIL')).forEach((s) => провалы.push('Blender: ' + s.slice(7)));
  if (r.status !== 0 || !строки.length) провалы.push(`Blender завершился с кодом ${r.status}: ${(r.stderr || '').slice(-400)}`);
}

app.whenReady().then(main).then(
  () => {
    console.log(провалы.length ? `\nПРОВАЛ: ${провалы.length}` : '\nВсё на месте.');
    app.exit(провалы.length ? 1 : 0);
  },
  (e) => { console.error('Ошибка проверки:', e); app.exit(2); },
);

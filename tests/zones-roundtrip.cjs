/**
 * Проверка: зоны и выгрузка «Для игры» на персонаже с костями и клипами.
 *
 *   kid.glb — один меш «Skin», 324 грани, 668 вершин, скелет из двух костей,
 *   клипы Idle и Nod. Лицо — выделением граней головы, две зоны — выделением.
 *
 * Что держит проверка:
 *   - правила зон: имя — латиница, цифры, «_»; «Face» и занятые имена нельзя;
 *     грани лица в зону не берутся; новая зона забирает грани у старой;
 *   - проект: зоны те же после открытия (имя, меш, грани байт в байт), проект
 *     без зон открывается как раньше;
 *   - «Для игры» ПОСЛЕ ОТКРЫТИЯ ПРОЕКТА: в GLB примитивы «тело, Face, зоны по
 *     списку» с именами материалов, число граней и вершин как в исходнике,
 *     скелет, клипы — те же имена, длительности и число дорожек, что в
 *     kid.glb; `_face.json` прежнего формата с полем `zones`;
 *   - модель без лица и без зон: «Для игры» = «GLB — один файл» байт в байт;
 *   - OBJ: группы материалов с именами зон;
 *   - тот же GLB в Blender (если установлен): зоны — слоты меша с костями.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('./harness.cjs');

/** Описание GLB: JSON-часть файла. */
function glbJSON(буфер) {
  const n = буфер.readUInt32LE(12);
  return JSON.parse(буфер.subarray(20, 20 + n).toString('utf8'));
}

/** Клипы GLB: имя → { длительность, дорожек }. */
function клипыGLB(j) {
  return Object.fromEntries((j.animations || []).map((a) => [a.name, {
    duration: +Math.max(...a.samplers.map((s) => j.accessors[s.input].max[0])).toFixed(4),
    channels: a.channels.length,
  }]));
}

/** Примитивы GLB: материал, граней, вершин (по атрибуту позиций). */
function примитивыGLB(j) {
  return j.meshes.flatMap((m) => m.primitives.map((p) => ({
    material: j.materials[p.material]?.name,
    tris: p.indices != null ? j.accessors[p.indices].count / 3 : j.accessors[p.attributes.POSITION].count / 3,
    position: p.attributes.POSITION,
  })));
}

/** Грани меша по условию на центр треугольника в мировых координатах. */
const ГРАНИ = (условие) => `(() => {
  const P = window.__paint, { mesh, cache } = P.viewport.paintables[0];
  const e = mesh.matrixWorld.elements, { pos, idx, triCount } = cache;
  const tris = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { const i = idx[t*3+k]*3;
      x += e[0]*pos[i] + e[4]*pos[i+1] + e[8]*pos[i+2] + e[12];
      y += e[1]*pos[i] + e[5]*pos[i+1] + e[9]*pos[i+2] + e[13];
      z += e[2]*pos[i] + e[6]*pos[i+1] + e[10]*pos[i+2] + e[14]; }
    x /= 3; y /= 3; z /= 3;
    if (${условие}) tris[t] = 1;
  }
  P.selectTris(mesh, tris);
  return tris.reduce((a, b) => a + b, 0);
})()`;

/** Зоны на странице: имя, номер меша, число граней, отпечаток граней. */
const ЗОНЫ = `window.__paint.state.zones.map((z) => ({
  name: z.name, mesh: window.__paint.viewport.paintables.findIndex((p) => p.mesh === z.mesh),
  tris: z.tris.reduce((a, b) => a + b, 0), sum: z.tris.reduce((s, v, i) => (s * 31 + v * (i + 1)) >>> 0, 0),
}))`;

/** Набор «Для игры» → имена, base64, описание json. */
const ДЛЯ_ИГРЫ = `(async () => {
  const files = await window.__paint.gameFiles('kid');
  const out = { names: files.map((x) => x.name), b64: {} };
  for (const x of files) {
    out.b64[x.name] = await window.__b64(x.blob);
    if (x.name.endsWith('.json')) out.json = JSON.parse(await x.blob.text());
  }
  return out;
})()`;

run('Зоны и выгрузка «Для игры»', async ({ js, check, open, save, fixture, blender }) => {
  const исходник = glbJSON(fs.readFileSync(path.join(__dirname, 'fixtures', 'kid.glb')));
  const клипыИсходника = клипыGLB(исходник);
  const примИсх = примитивыGLB(исходник);
  const гранейИсх = примИсх.reduce((a, p) => a + p.tris, 0);
  const вершинИсх = исходник.accessors[примИсх[0].position].count;
  console.log(`  исходник: граней ${гранейИсх}, вершин ${вершинИсх}, клипы ${JSON.stringify(клипыИсходника)}`);

  // 0. Модель без лица и без зон: «Для игры» — тот же GLB, что «GLB — один файл».
  check(await open(fixture('kid.glb'), 'kid.glb'), 'kid.glb открылся');
  const чистая = await js(`(async () => {
    const P = window.__paint;
    const game = await P.gameFiles('kid');
    return { names: game.map((x) => x.name), game: await window.__b64(game[0].blob), glb: await window.__b64(await P.exportGLB()) };
  })()`);
  check(JSON.stringify(чистая.names) === '["kid.glb"]', `без лица и зон — один файл: ${чистая.names.join(', ')}`);
  check(чистая.game === чистая.glb, '«Для игры» без лица и зон = «GLB — один файл» байт в байт');

  // 1. Лицо — грани головы спереди (как в face-roundtrip).
  const лица = await js(ГРАНИ('y > 1.0 && z > 0.12'));
  check(await js('window.__paint.faceFromSelection()') === true, `лицо задано (${лица} граней выделено)`);
  const гранейЛица = await js('window.__paint.state.face.tris.reduce((a, b) => a + b, 0)');
  // Нарисованное «всё лицо · нейтральное» — чтобы в наборе был атлас.
  await js(`(async () => {
    const P = window.__paint, tg = P.targets.get(P.state.face.mesh);
    P.faceAdd('full', 'neutral');
    await window.__mcp.call('fill', { target: { mesh: 0 }, color: '#e04020', layer: tg.layers.findIndex((L) => L.slot === 'full') });
  })()`);

  // 2. Правила имени.
  await js(ГРАНИ('y > 0.55 && y < 0.8'));
  const имена = await js(`(() => {
    const P = window.__paint, r = {};
    for (const имя of ['Kid Crystal', 'Кристалл', 'face', 'Skin', '']) r[имя || '(пусто)'] = P.zoneFromSelection(имя);
    r.zones = P.state.zones.length;
    return r;
  })()`);
  check(Object.entries(имена).every(([k, v]) => k === 'zones' ? v === 0 : v === false),
    `неверные имена отклонены: ${JSON.stringify(имена)}`);

  // 3. Две зоны: кулон (грудь) и камень на ногах.
  const кулон = await js('window.__paint.zoneFromSelection("Kid_Crystal")');
  await js(ГРАНИ('y < 0.25'));
  const камень = await js('window.__paint.zoneFromSelection("Kid_Gem")');
  const занято = await (async () => { await js(ГРАНИ('y < 0.1')); return js('window.__paint.zoneFromSelection("kid_gem")'); })();
  check(кулон && камень && занято === false, 'зоны Kid_Crystal и Kid_Gem созданы; «kid_gem» — занято');

  // 4. Грани лица в зону не берутся: зона из головы целиком.
  const сЛицом = await js(`(() => { ${ГРАНИ('y > 0.95')}; const P = window.__paint;
    const ok = P.zoneFromSelection('Kid_Head');
    const z = P.state.zones.find((x) => x.name === 'Kid_Head'), f = P.state.face.tris;
    let общих = 0; if (z) for (let i = 0; i < f.length; i++) if (f[i] && z.tris[i]) общих++;
    return { ok, общих, граней: z ? z.tris.reduce((a, b) => a + b, 0) : 0 };
  })()`);
  check(сЛицом.ok && сЛицом.граней > 0 && сЛицом.общих === 0, `зона из головы: ${сЛицом.граней} граней, общих с лицом ${сЛицом.общих}`);

  // 5. Новая зона забирает грани у старой; опустевшая уходит.
  const забрала = await js(`(() => { const P = window.__paint;
    const до = P.state.zones.find((x) => x.name === 'Kid_Head').tris.reduce((a, b) => a + b, 0);
    ${ГРАНИ('y > 0.95')};
    P.zoneFromSelection('Kid_Hair');
    return { до, остались: P.state.zones.map((z) => z.name) };
  })()`);
  check(!забрала.остались.includes('Kid_Head') && забрала.остались.includes('Kid_Hair'),
    `Kid_Hair забрала грани Kid_Head (${забрала.до}), опустевшая ушла: ${забрала.остались.join(', ')}`);
  await js(`(() => { const P = window.__paint; P.zoneDelete(P.state.zones.findIndex((z) => z.name === 'Kid_Hair')); })()`);

  // 6. Переименование и «Обновить из выделения».
  const правка = await js(`(() => { const P = window.__paint;
    const k = P.state.zones.findIndex((z) => z.name === 'Kid_Gem');
    const плохо = P.zoneRename(k, 'Kid_Crystal');
    const хорошо = P.zoneRename(k, 'Kid_Stone');
    P.zoneSelect(k);
    const выделено = [...P.targets.values()].some((t) => t.selection);
    const было = P.state.zones[k].tris.reduce((a, b) => a + b, 0);
    P.zoneUpdate();
    return { плохо, хорошо, выделено, было, стало: P.state.zones[k].tris.reduce((a, b) => a + b, 0), имя: P.state.zones[k].name };
  })()`);
  check(правка.плохо === false && правка.хорошо && правка.имя === 'Kid_Stone', `переименование: занятое отклонено, стало ${правка.имя}`);
  check(правка.выделено && правка.было === правка.стало, `строка выделяет грани зоны, «Обновить» без правки — те же ${правка.стало}`);

  // Лицо и зоны — строками под мешем в «UV объектов»; щелчок открывает часть.
  const строки = await js(`(async () => {
    const P = window.__paint;
    const имена = () => [...document.querySelectorAll('#uv-list .uv-row')].map((r) => (r.classList.contains('uv-part') ? '  ' : '') + r.querySelector('.uv-row-name').textContent);
    const r = { список: имена() };
    [...document.querySelectorAll('#uv-list .uv-part')].find((x) => x.querySelector('.uv-row-name').textContent === 'Kid_Stone').click();
    await new Promise((ok) => setTimeout(ok, 200));
    r.открыта = P.uvPart();
    r.выделено = [...P.targets.values()].some((t) => t.selection);
    return r;
  })()`);
  check(JSON.stringify(строки.список) === JSON.stringify(['Kid', '  Face', '  Kid_Crystal', '  Kid_Stone']),
    `развёртки: ${строки.список.join(' / ')}`);
  check(строки.открыта === 'Kid_Stone' && строки.выделено, 'строка зоны открывает её развёртку и выделяет её грани');

  const до = await js(ЗОНЫ);
  check(JSON.stringify(до.map((z) => z.name)) === '["Kid_Crystal","Kid_Stone"]', `зоны: ${до.map((z) => `${z.name} (${z.tris})`).join(', ')}`);

  // 7. Проект: сохранить, открыть — зоны те же.
  const проект = await js('window.__paint.projectBytes().then(window.__b64)');
  // Внутри проекта — как обещано смежным программам: project.json → zones.
  const файлПроекта = save(проект, 'kid.3dpaint');
  const pj = JSON.parse(spawnSync('unzip', ['-p', файлПроекта, 'project.json'], { encoding: 'utf8' }).stdout);
  const списокФайлов = spawnSync('unzip', ['-Z1', файлПроекта], { encoding: 'utf8' }).stdout.split('\n');
  check(JSON.stringify(pj.zones) === JSON.stringify([
    { name: 'Kid_Crystal', mesh: 0, tris: 'zones/0/tris.bin' }, { name: 'Kid_Stone', mesh: 0, tris: 'zones/1/tris.bin' }])
    && списокФайлов.includes('zones/0/tris.bin') && списокФайлов.includes('zones/1/tris.bin'),
    `project.json: zones ${JSON.stringify(pj.zones)}`);
  check(await open(проект, 'kid.3dpaint'), 'проект открылся снова');
  const после = await js(ЗОНЫ);
  check(JSON.stringify(после) === JSON.stringify(до), `из проекта: зоны те же ${JSON.stringify(после.map((z) => [z.name, z.mesh, z.tris]))}`);
  check(await js('window.__paint.state.face?.tris.reduce((a, b) => a + b, 0)') === гранейЛица, 'из проекта: лицо то же');
  const клипыПосле = await js(`Object.fromEntries((window.__paint.viewport.model.animations || []).map((c) => [c.name, { duration: +c.duration.toFixed(4), channels: c.tracks.length }]))`);
  check(Object.keys(клипыПосле).join() === Object.keys(клипыИсходника).join(), `из проекта: клипы ${Object.keys(клипыПосле).join(', ')} на месте`);

  // 8. «Для игры» после открытия проекта.
  const игра = await js(ДЛЯ_ИГРЫ);
  check(JSON.stringify(игра.names) === JSON.stringify(['kid.glb', 'kid_face_full.png', 'kid_face.json']),
    `файлы: ${игра.names.join(', ')}`);
  const glbФайл = save(игра.b64['kid.glb'], 'kid-game.glb');
  const j = glbJSON(fs.readFileSync(glbФайл));
  const прим = примитивыGLB(j);
  check(JSON.stringify(прим.map((p) => p.material)) === '["Skin","Face","Kid_Crystal","Kid_Stone"]',
    `примитивы по порядку: ${прим.map((p) => `${p.material} (${p.tris})`).join(', ')}`);
  check(прим[1].tris === гранейЛица && прим[2].tris === до[0].tris && прим[3].tris === до[1].tris,
    `граней в примитивах: лицо ${прим[1].tris}, зоны ${прим[2].tris} и ${прим[3].tris}`);
  check(прим.reduce((a, p) => a + p.tris, 0) === гранейИсх, `всего граней ${прим.reduce((a, p) => a + p.tris, 0)} = исходник ${гранейИсх}`);
  const вершин = j.accessors[прим[0].position].count;
  check(прим.every((p) => p.position === прим[0].position) && вершин === вершинИсх,
    `вершины общие на примитивы, ${вершин} = исходник ${вершинИсх}`);
  check(j.skins?.length === 1 && j.skins[0].joints.length === исходник.skins[0].joints.length, `скелет: ${j.skins?.[0]?.joints.length} кости`);
  const клипыИгры = клипыGLB(j);
  check(JSON.stringify(клипыИгры) === JSON.stringify(клипыИсходника),
    `клипы «Для игры» после проекта ${JSON.stringify(клипыИгры)} = kid.glb`);
  // Материалы зон — с той же картой, что тело (та же развёртка, та же картинка).
  const карта = (имя) => j.materials.find((m) => m.name === имя)?.pbrMetallicRoughness?.baseColorTexture?.index;
  check(карта('Kid_Crystal') != null && карта('Kid_Stone') != null && карта('Face') != null, 'у зон и лица есть карта цвета');

  const опис = игра.json;
  check(опис.format === '3dpainter-face' && опис.version === 1 && опис.material === 'Face', `описание: ${опис.format} v${опис.version}, материал ${опис.material}`);
  check(JSON.stringify(опис.zones) === '["Kid_Crystal","Kid_Stone"]', `описание: zones ${JSON.stringify(опис.zones)}`);

  // 9. OBJ — группы материалов с именами зон.
  const obj = await js(`(async () => { const { obj, mtl } = await window.__paint.exportOBJ('kid');
    const o = await obj.text(), m = await mtl.text();
    return { usemtl: o.split('\\n').filter((l) => l.startsWith('usemtl ')), f: o.split('\\n').filter((l) => l.startsWith('f ')).length,
      newmtl: m.split('\\n').filter((l) => l.startsWith('newmtl ')) };
  })()`);
  check(JSON.stringify(obj.usemtl) === '["usemtl painted","usemtl Face","usemtl Kid_Crystal","usemtl Kid_Stone"]' && obj.f === гранейИсх,
    `OBJ: ${obj.usemtl.join(', ')}; граней ${obj.f}`);
  check(JSON.stringify(obj.newmtl) === '["newmtl painted","newmtl Face","newmtl Kid_Crystal","newmtl Kid_Stone"]', `MTL: ${obj.newmtl.join(', ')}`);

  // 10. Проект без зон — открывается как раньше, зон нет.
  const безЗон = await js(`(async () => { const P = window.__paint;
    while (P.state.zones.length) P.zoneDelete(0);
    return window.__b64(await P.projectBytes());
  })()`);
  check(await open(безЗон, 'kid-nozones.3dpaint'), 'проект без зон открылся');
  check((await js('window.__paint.state.zones.length')) === 0, 'проект без зон: зон нет');
  const безЗонИгра = await js(ДЛЯ_ИГРЫ);
  check(JSON.stringify(безЗонИгра.json.zones) === '[]', 'без зон: в описании zones = []');

  // 11. Blender: зоны — слоты меша с костями, клипы на месте.
  const clipsArg = Object.entries(клипыИсходника).map(([n, c]) => `${n}:${c.duration}`).join(',');
  blender(glbФайл, ['--clips', clipsArg, '--materials', 'Skin,Face,Kid_Crystal,Kid_Stone', '--zones', 'Kid_Crystal,Kid_Stone']);
});

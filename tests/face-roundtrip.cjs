/**
 * Проверка: лицо с выражениями на двух разных персонажах из Blender.
 *
 *   kid.glb — один материал «Skin», лицо задаётся выделением граней головы;
 *   fox.glb — лицо берётся по материалу «Face».
 *
 * У каждого рисуются три выражения (нейтральное, радость, грусть — глаза и
 * рот строками списка) и два накладываются из PNG спереди: глаза «удивление»
 * и всё лицо «злость». Затем:
 *   - выгрузка: GLB с теми же клипами и материалом «Face», атласы глаз и рта,
 *     json; нейтральная клетка атласа совпадает с лицом в текстуре GLB —
 *     так проверяется, что клетка ложится на UV лица, а не вверх ногами;
 *   - повторное открытие проекта: лицо и все выражения на месте байт в байт;
 *   - повторное открытие GLB: клипы и материал «Face» на месте;
 *   - тот же GLB в Blender (если установлен).
 */

const { run } = require('./harness.cjs');

const ВЫРАЖЕНИЯ = [
  ['neutral', '#2050e0', '#e04020'],
  ['joy', '#20c0e0', '#f0d020'],
  ['sad', '#8020e0', '#30a040'],
];

/** Сведения о лице на странице: грани, выражения, отпечатки вырезок. */
const ЛИЦО = `(() => {
  const P = window.__paint, f = P.state.face;
  if (!f) return null;
  P.faceCommit();                    // показанное уходит в вырезку
  const сумма = (c) => { let s = 0; for (let i = 0; i < c.rgba.length; i += 7) s = (s * 31 + c.rgba[i]) >>> 0; return s; };
  const слот = (slot) => Object.fromEntries([...f.exprs[slot]].map(([id, c]) => [id, сумма(c)]));
  return {
    mesh: f.mesh.name, source: f.source, tris: f.tris.reduce((a, b) => a + b, 0), rect: f.rect, mouth: f.mouth,
    eyes: слот('eyes'), mouthExprs: слот('mouth'), full: слот('full'), list: f.list,
  };
})()`;

/** Клипы открытой модели: имя → длительность. */
const КЛИПЫ = `Object.fromEntries((window.__paint.viewport.model.animations || []).map((c) => [c.name, +c.duration.toFixed(4)]))`;

run('Лицо с выражениями', async ({ js, check, open, save, fixture, blender }) => {
  for (const м of [
    { file: 'kid.glb', how: 'select', skin: 'Skin' },
    { file: 'fox.glb', how: 'material', skin: 'Fur' },
  ]) {
    console.log(`\n— ${м.file} (лицо: ${м.how === 'select' ? 'выделением граней' : 'по материалу «Face»'})`);
    check(await open(fixture(м.file), м.file), `${м.file} открылся`);
    const клипы = await js(КЛИПЫ);

    // 1. Задать лицо.
    const задано = await js(м.how === 'select' ? `(() => {
      // Как лассо: грани головы спереди (глаза и рот — на них).
      const P = window.__paint, { mesh, cache } = P.viewport.paintables[0];
      const e = mesh.matrixWorld.elements, { pos, idx, triCount } = cache;
      const tris = new Uint8Array(triCount);
      for (let t = 0; t < triCount; t++) {
        let y = 0, z = 0;
        for (let k = 0; k < 3; k++) { const i = idx[t*3+k]*3;
          y += e[1]*pos[i] + e[5]*pos[i+1] + e[9]*pos[i+2] + e[13]; z += e[2]*pos[i] + e[6]*pos[i+1] + e[10]*pos[i+2] + e[14]; }
        if (y / 3 > 1.0 && z / 3 > 0.12) tris[t] = 1;
      }
      P.selectTris(mesh, tris);
      return P.faceFromSelection();
    })()` : `window.__paint.faceFromMaterial('Face')`);
    check(задано === true, 'лицо задано');

    // 2. Три выражения: глаза — верх лица, рот — низ.
    await js(`(async () => {
      const P = window.__paint, f = P.state.face;
      const i = P.viewport.paintables.findIndex((p) => p.mesh === f.mesh);
      const box = P.viewport.trisBox(f.mesh, f.mesh.userData.paintCache, f.tris);
      const mid = (box.min.y + box.max.y) / 2;
      const tg = P.targets.get(f.mesh);
      const слой = (slot) => tg.layers.findIndex((L) => L.slot === slot);
      // Как человек: часть, «+», имя, Enter — строка готова, в неё и красим.
      for (const [id, глаза, рот] of ${JSON.stringify(ВЫРАЖЕНИЯ)}) {
        P.faceAdd('eyes', id);
        await window.__mcp.call('fill', { target: { mesh: i, above: mid }, color: глаза, layer: слой('eyes') });
        P.faceAdd('mouth', id);
        await window.__mcp.call('fill', { target: { mesh: i, below: mid }, color: рот, layer: слой('mouth') });
      }
    })()`);

    // 3. Из готовых рисунков PNG, спереди: глаза «удивление» и всё лицо «злость».
    for (const [часть, id, цвет] of [['eyes', 'surprise', '#e02020'], ['full', 'anger', '#c01080']]) {
      const наложено = await js(`(async () => {
        const P = window.__paint;
        P.faceAdd('${часть}', '${id}');
        const c = document.createElement('canvas'); c.width = 256; c.height = 160;
        const g = c.getContext('2d'); g.fillStyle = '${цвет}';
        g.beginPath(); g.arc(80, 70, 40, 0, Math.PI * 2); g.arc(176, 70, 40, 0, Math.PI * 2); g.fill();
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const ok = await P.faceOverlay(new File([blob], '${id}.png', { type: 'image/png' }));
        const вид = [P.viewport.currentViewName(), P.viewport.projection];
        P.applyDecal();
        return { ok, вид };
      })()`);
      check(наложено.ok && наложено.вид.join() === 'front,ortho', `PNG «${id}» (${часть}) наложен спереди (${наложено.вид.join(', ')})`);
    }

    const до = await js(ЛИЦО);
    check(JSON.stringify(Object.keys(до.eyes)) === '["neutral","joy","sad","surprise"]', `глаза: ${Object.keys(до.eyes).join(', ')}`);
    check(JSON.stringify(Object.keys(до.mouthExprs)) === '["neutral","joy","sad"]', `рот: ${Object.keys(до.mouthExprs).join(', ')}`);
    check(JSON.stringify(Object.keys(до.full)) === '["anger"]', `всё лицо: ${Object.keys(до.full).join(', ')}`);

    // 4. Выгрузка набора.
    const выгрузка = await js(`(async () => {
      const P = window.__paint, f = P.state.face;
      const files = await P.faceFiles();
      const out = { names: files.map((x) => x.name), b64: {} };
      for (const x of files) {
        out.b64[x.name] = await window.__b64(x.blob);
        if (x.name.endsWith('.json')) out.json = JSON.parse(await x.blob.text());
        if (x.name.endsWith('.png')) { const b = await createImageBitmap(x.blob); out[x.name] = [b.width, b.height]; }
      }
      // GLB: материалы, клипы и картинка «Face».
      const glbFile = files.find((x) => x.name.endsWith('.glb'));
      const bytes = new Uint8Array(await glbFile.blob.arrayBuffer());
      const dv = new DataView(bytes.buffer);
      const n = dv.getUint32(12, true);
      const j = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + n)));
      const bin = bytes.subarray(20 + n + 8);
      out.materials = j.materials.map((m) => m.name);
      const acc = j.accessors;
      out.clips = Object.fromEntries((j.animations || []).map((a) => [a.name, +Math.max(...a.samplers.map((s) => acc[s.input].max[0])).toFixed(4)]));
      const face = j.materials.find((m) => m.name === 'Face');
      const tex = face && j.textures[face.pbrMetallicRoughness.baseColorTexture.index];
      const img = tex && j.images[tex.source], bv = img && j.bufferViews[img.bufferView];
      const faceImg = await createImageBitmap(new Blob([bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)], { type: img.mimeType }));
      const cv = (b) => { const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const g = c.getContext('2d'); g.drawImage(b, 0, 0); return g.getImageData(0, 0, b.width, b.height).data; };
      const gpx = cv(faceImg);
      // Нейтральная клетка атласа глаз (клетка 0) против лица в текстуре GLB.
      const eyesFile = files.find((x) => x.name.endsWith('_face_eyes.png'));
      const atlas = await createImageBitmap(eyesFile.blob);
      const apx = cv(atlas);
      // Где поверх глаз лежит рот (грани на линии раздела получили обе
      // заливки), в текстуре виден рот — такие тексели не сравниваем.
      const mouthAtlas = await createImageBitmap(files.find((x) => x.name.endsWith('_face_mouth.png')).blob);
      const mpx = cv(mouthAtlas);
      const R = out.json.faceRect, W = faceImg.width;
      let всего = 0, совпало = 0;
      for (let y = 0; y < R.height; y++) for (let x = 0; x < R.width; x++) {
        const a = (y * atlas.width + x) * 4;
        if (apx[a + 3] < 255 || mpx[(y * mouthAtlas.width + x) * 4 + 3] > 0) continue;
        всего += 1;
        const g = ((R.y + y) * W + (R.x + x)) * 4;
        if (Math.abs(gpx[g] - apx[a]) + Math.abs(gpx[g + 1] - apx[a + 1]) + Math.abs(gpx[g + 2] - apx[a + 2]) < 24) совпало += 1;
      }
      out.cellMatch = [совпало, всего];
      return out;
    })()`);
    const основа = м.file.replace('.glb', '');
    check(JSON.stringify(выгрузка.names) === JSON.stringify([`${основа}.glb`, `${основа}_face_eyes.png`, `${основа}_face_mouth.png`, `${основа}_face_full.png`, `${основа}_face.json`]),
      `файлы: ${выгрузка.names.join(', ')}`);
    check(выгрузка.materials.includes('Face') && выгрузка.materials.includes(м.skin), `материалы GLB: ${выгрузка.materials.join(', ')}`);
    check(JSON.stringify(выгрузка.clips) === JSON.stringify(клипы), `клипы GLB ${JSON.stringify(выгрузка.clips)} = исходные ${JSON.stringify(клипы)}`);
    const j = выгрузка.json;
    check(JSON.stringify(j.eyes?.expressions) === '["neutral","joy","sad","surprise"]' && JSON.stringify(j.mouth?.expressions) === '["neutral","joy","sad"]'
      && JSON.stringify(j.full?.expressions) === '["anger"]',
      `json: глаза ${j.eyes?.expressions}, рот ${j.mouth?.expressions}, всё лицо ${j.full?.expressions}`);
    check(j.cell.width === j.faceRect.width && j.cell.height === j.faceRect.height, `клетка ${j.cell.width}×${j.cell.height} = прямоугольник лица`);
    for (const slot of ['eyes', 'mouth', 'full']) {
      const размер = выгрузка[j[slot].file];
      check(размер[0] === j[slot].columns * j.cell.width && размер[1] === j[slot].rows * j.cell.height,
        `атлас ${slot}: ${размер.join('×')} = ${j[slot].columns}×${j[slot].rows} клеток`);
    }
    const [совпало, всего] = выгрузка.cellMatch;
    check(всего > 100 && совпало / всего > 0.98, `нейтральная клетка ложится на лицо в GLB: ${совпало} из ${всего} текселей`);
    const glb = save(выгрузка.b64[`${основа}.glb`], `${основа}-face.glb`);
    for (const [имя, b64] of Object.entries(выгрузка.b64)) if (!имя.endsWith('.glb')) save(b64, имя);

    // 5. Проект: открыть снова — всё на месте.
    const проект = await js(`window.__paint.projectBytes().then(window.__b64)`);
    check(await open(проект, `${основа}.3dpaint`), 'проект открылся снова');
    const после = await js(ЛИЦО);
    check(!!после && после.source === до.source && после.tris === до.tris && JSON.stringify(после.rect) === JSON.stringify(до.rect),
      `из проекта: лицо (${после?.source}, граней ${после?.tris})`);
    check(JSON.stringify(после?.eyes) === JSON.stringify(до.eyes) && JSON.stringify(после?.mouthExprs) === JSON.stringify(до.mouthExprs)
      && JSON.stringify(после?.full) === JSON.stringify(до.full), 'из проекта: все выражения байт в байт');
    check(JSON.stringify(после?.list) === JSON.stringify(до.list), `из проекта: список выражений (${после?.list?.length} строк)`);
    check(JSON.stringify(await js(КЛИПЫ)) === JSON.stringify(клипы), 'из проекта: клипы на месте');

    // 6. Выгруженный GLB — открыть снова.
    check(await open(выгрузка.b64[`${основа}.glb`], `${основа}-face.glb`), 'выгруженный GLB открылся');
    check(JSON.stringify(await js(КЛИПЫ)) === JSON.stringify(клипы), 'из GLB: клипы на месте');
    const материалы = await js(`window.__paint.viewport.paintables.map((p) => p.mesh.userData.sourceMaterialName)`);
    check(материалы.includes('Face') && материалы.includes(м.skin), `из GLB: материалы ${материалы.join(', ')}`);

    // 7. Рот выключен — атласа рта нет, в описании рот пуст.
    if (м.how === 'material') {
      await open(проект, `${основа}.3dpaint`);
      const безРта = await js(`(async () => {
        const P = window.__paint; P.setMouth(false);
        const files = await P.faceFiles();
        const j = JSON.parse(await files.find((x) => x.name.endsWith('.json')).blob.text());
        return { names: files.map((x) => x.name), mouth: j.mouth };
      })()`);
      check(безРта.mouth === null && !безРта.names.some((n) => n.endsWith('_mouth.png')), `рот выключен: ${безРта.names.join(', ')}`);
    }

    // 8. Картинка на строке: поправить теми же ручками, отменить, стереть —
    //    и поправить после повторного открытия проекта.
    if (м.how === 'material') {
      const правка = await js(`(async () => {
        const P = window.__paint, f = P.state.face;
        const n = () => { P.faceCommit(); const c = f.exprs.eyes.get('surprise'); let k = 0; if (c) for (let i = 3; i < c.rgba.length; i += 4) if (c.rgba[i]) k++; return k; };
        const отпечаток = () => { P.faceCommit(); const c = f.exprs.eyes.get('surprise'); let s = 0; if (c) for (let i = 0; i < c.rgba.length; i += 5) s = (s * 31 + c.rgba[i]) >>> 0; return s; };
        P.faceSelect('eyes', 'surprise');
        const r = { есть: f.overlays.eyes.has('surprise'), было: отпечаток(), n0: n() };
        r.кнопки = [...document.querySelectorAll('#face-list .expr-row.on .expr-act')].map((b) => b.className.replace('expr-act ', ''));
        await P.faceOverlayEdit('eyes', 'surprise');
        r.вПравке = n();                              // основа без картинки
        P.decal.quad.forEach((c) => { c.x += 30; c.y -= 10; });
        P.applyDecal();
        r.сдвинуто = отпечаток();
        P.history.undo(); r.отмена = отпечаток();
        P.history.redo();
        await P.faceOverlayEdit('eyes', 'surprise'); P.cancelDecal(); r.esc = отпечаток();
        r.стало = отпечаток();
        return r;
      })()`);
      check(правка.есть && JSON.stringify(правка.кнопки) === '["edit","replace","clear"]', `на строке: ${правка.кнопки.join(', ')}`);
      check(правка.вПравке === 0, 'в правке картинка снята до основы');
      check(правка.сдвинуто !== правка.было && правка.отмена === правка.было, 'сдвиг рамки впечатан, отмена возвращает прежнее');
      check(правка.esc === правка.сдвинуто, 'Esc в правке — как было');
      const проект2 = await js(`window.__paint.projectBytes().then(window.__b64)`);
      await open(проект2, `${основа}-2.3dpaint`);
      const снова = await js(`(async () => {
        const P = window.__paint, f = P.state.face;
        const отпечаток = () => { P.faceCommit(); const c = f.exprs.eyes.get('surprise'); let s = 0; if (c) for (let i = 0; i < c.rgba.length; i += 5) s = (s * 31 + c.rgba[i]) >>> 0; return s; };
        const r = { есть: f.overlays.eyes.has('surprise'), было: отпечаток() };
        r.правка = await P.faceOverlayEdit('eyes', 'surprise');
        P.decal.quad.forEach((c) => { c.x -= 30; });
        P.applyDecal();
        r.после = отпечаток();
        P.faceClear('eyes', 'surprise');
        P.faceCommit(); r.стёрто = !f.exprs.eyes.has('surprise') && !f.overlays.eyes.has('surprise');
        P.history.undo(); r.вернулось = отпечаток();
        return r;
      })()`);
      check(снова.есть && снова.было === правка.стало, 'из проекта: картинка строки и её наложение на месте');
      check(снова.правка && снова.после !== снова.было, 'из проекта: картинку можно поправить');
      check(снова.стёрто && снова.вернулось === снова.после, 'стереть и отменить стирание');
    }

    const clipsArg = Object.entries(клипы).map(([n, d]) => `${n}:${d}`).join(',');
    blender(glb, ['--clips', clipsArg, '--materials', `${м.skin},Face`]);
  }
});

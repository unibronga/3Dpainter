/**
 * Итог сохранения: файлы ложатся туда, куда выбрали, и об этом видна плашка.
 *
 *   node tests/save-roundtrip.cjs     (npm test зовёт сам, после сборки)
 *
 * Настоящая оболочка; системное окно выбора заменено переменной
 * `PAINT_TOOL_TEST_PICK` — место «выбирается» само, остальной путь тот же:
 * номер места, запись оболочкой, плашка, «Показать в Finder» (отвечает путём).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3dpainter-save-'));
const куда = path.join(tmp, 'Сохранения (тест)');
fs.mkdirSync(куда);
const { запустить, cdp, пауза } = require('./live.cjs')({ tmp, env: { PAINT_TOOL_TEST_PICK: куда } });

const провалы = [];
function check(условие, что) {
  console.log(`${условие ? '  ok ' : '  FAIL'} ${что}`);
  if (!условие) провалы.push(что);
}
const список = () => fs.readdirSync(куда).sort();

(async () => {
  console.log('\nИтог сохранения:');
  const app = запустить();
  const c = await cdp();
  await c.js('window.__paint.welcome.hide(), 1');
  const плашка = () => c.js('window.__paint.toastState()');
  const ждатьПлашку = async (было) => {
    for (let i = 0; i < 100; i++) {
      const п = await плашка();
      if (п && JSON.stringify(п) !== было) return п;
      await пауза(100);
    }
    return null;
  };

  // 1. Один файл: GLB.
  await c.js('window.__paint.saveAs("glb")');
  let п = await ждатьПлашку('');
  const glb = список().find((f) => f.endsWith('.glb'));
  check(!!glb && fs.statSync(path.join(куда, glb)).size > 1000, `GLB записан в выбранное место (${glb})`);
  check(п?.ok && п.title === 'Сохранено' && п.name === glb, `плашка «Сохранено» с именем файла (${п?.title} · ${п?.name})`);
  check(п?.where === 'в папке «Сохранения (тест)»', `плашка говорит, где лежит (${п?.where})`);
  check(п?.reveal && /Finder|Проводник/.test(п.revealText), `кнопка «${п?.revealText}»`);
  await c.js('document.querySelector(".toast-reveal").click()');
  await пауза(300);
  п = await плашка();
  check(п?.opened === path.join(куда, glb), `«Показать» открывает именно этот файл (${п?.opened})`);

  // 2. Набор: OBJ + MTL + PNG — папкой; второй раз — «имя 2».
  await c.js('window.__paint.saveAs("obj")');
  п = await ждатьПлашку(JSON.stringify(п));
  const папки = список().filter((f) => fs.statSync(path.join(куда, f)).isDirectory());
  check(папки.length === 1 && fs.readdirSync(path.join(куда, папки[0])).length === 3, `OBJ — папкой из трёх файлов (${папки[0]}: ${папки[0] ? fs.readdirSync(path.join(куда, папки[0])).join(', ') : '—'})`);
  check(п?.name === папки[0] && /файлов: 3/.test(п.where), `плашка: папка и число файлов (${п?.name} · ${п?.where})`);
  await c.js('document.querySelector(".toast-reveal").click()');
  await пауза(300);
  check((await плашка())?.opened === path.join(куда, папки[0]), '«Показать» открывает папку набора');
  const доВторого = JSON.stringify(await плашка());   // saveAs ждёт конца сохранения — снимаем ДО
  await c.js('window.__paint.saveAs("obj")');
  п = await ждатьПлашку(доВторого);
  check(список().includes(`${папки[0]} 2`) && п?.name === `${папки[0]} 2`, 'повторный набор — в «имя 2», чужое не перезаписано');

  // 3. Проект: «Сохранить как», потом ⌘S — в тот же файл, без окна.
  await c.js('window.__paint.saveAs("project")');
  п = await ждатьПлашку(JSON.stringify(п));
  const проект = список().find((f) => f.endsWith('.3dpaint'));
  check(!!проект && п?.name === проект, `проект записан, плашка с его именем (${проект})`);
  const размер = fs.statSync(path.join(куда, проект)).mtimeMs;
  await пауза(1100);
  await c.js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, ctrlKey: true, bubbles: true }))');
  for (let i = 0; i < 50 && fs.statSync(path.join(куда, проект)).mtimeMs === размер; i++) await пауза(100);
  check(fs.statSync(path.join(куда, проект)).mtimeMs > размер && список().filter((f) => f.endsWith('.3dpaint')).length === 1, '⌘S пишет в тот же проект, новый не появляется');

  // 4. Вид в PNG.
  await c.js('document.getElementById("btn-view-png").click(), 1');
  await пауза(300);
  const былоПлашка = JSON.stringify(await плашка());
  await c.js('[...document.querySelectorAll(".modal-back.open .btn.accent")].pop().click(), 1');
  п = await ждатьПлашку(былоПлашка);
  const вид = список().find((f) => f.endsWith('_view.png'));
  check(!!вид && п?.name === вид, `«Вид в PNG» — файл и плашка (${вид})`);

  // 5. Язык меняется — плашка перерисовывается.
  await c.js('window.__paint.setLang("en")');
  п = await плашка();
  check(п?.title === 'Saved' && п.revealText === 'Show in Finder', `плашка на английском (${п?.title} · ${п?.revealText})`);
  await c.js('window.__paint.setLang("ru")');

  // 6. Не вышло — заметно, красным, с причиной.
  fs.chmodSync(куда, 0o555);
  const доОшибки = JSON.stringify(await плашка());
  await c.js('window.__paint.saveAs("glb")');
  п = await ждатьПлашку(доОшибки);
  fs.chmodSync(куда, 0o755);
  check(п && !п.ok && п.title === 'Не сохранено' && п.name === 'Нет прав на запись в эту папку.' && !п.reveal, `ошибка — плашка «Не сохранено» с понятной причиной: «${п?.name}»`);

  // 7. Крестик закрывает.
  await c.js('document.querySelector(".toast-x").click()');
  check((await плашка()) === null, 'крестик убирает плашку');

  const ошибки = await c.js('window.__paint.bootErrors');
  check(!ошибки.length, 'без ошибок запуска');
  c.close();
  app.kill();
  await app.вышел;
  if (провалы.length) console.log('\nЛог оболочки (хвост):\n' + app.лог.slice(-1500));
  console.log(провалы.length ? `\nПРОВАЛ: ${провалы.length}` : '\nВсё на месте.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(провалы.length ? 1 : 0);
})().catch((e) => { console.error('Ошибка проверки:', e); process.exit(2); });

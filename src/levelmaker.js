/**
 * Покраска из LevelMaker — сторона страницы.
 *
 * Оболочка (`electron/levelmaker.cjs`) разбирает файл задания и присылает его
 * сюда по номеру. Мы открываем модель (или проект прошлой покраски той же
 * модели), показываем полосу «Из LevelMaker: <имя>» и по кнопке «Сохранить и
 * вернуть» отдаём оболочке байты: GLB — тот же, что «Сохранить как › GLB»,
 * спутники лица и проект. Пишет файлы и состояние оболочка.
 *
 * Пока полоса видна, остальная программа работает как обычно. Открыли другую
 * модель — задание закрывается состоянием `cancelled`.
 */

import { t, getLang, onLangChange } from './i18n.js';
import { parseModel } from './formats.js';
import { readProjectMeta } from './project.js';
import { withBusy } from './busy.js';
import * as THREE from 'three';

/**
 * Подпись геометрии: число треугольников по мешам в порядке обхода и габарит.
 * По ней решается, от этой ли модели лежит проект. Считается одной функцией и
 * при сохранении, и при открытии — значит, сравнивается одинаково.
 */
export async function подписьМодели(буфер, имя) {
  const модель = await parseModel(буфер.slice(0), имя);
  модель.updateMatrixWorld(true);
  const tris = [];
  модель.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    tris.push(Math.round((g.index ? g.index.count : g.attributes.position?.count || 0) / 3));
  });
  const size = new THREE.Box3().setFromObject(модель).getSize(new THREE.Vector3());
  return { tris, size: size.toArray().map((v) => +v.toFixed(5)) };
}

function таЖеПодпись(а, б) {
  if (!а || !б || !Array.isArray(а.tris) || !Array.isArray(б.tris)) return false;
  if (а.tris.length !== б.tris.length || а.tris.some((n, i) => n !== б.tris[i])) return false;
  // Габарит — с допуском в 1%: числа прошли через JSON и экспорт.
  return а.size.every((v, i) => Math.abs(v - б.size[i]) <= Math.max(1e-4, Math.abs(v) * 0.01));
}

/** Имя файла без папки и окончания — для обоих видов разделителей. */
const основаИмени = (путь) => путь.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

/** Ошибка IPC приходит с приставкой «Error invoking remote method …: Error: …». */
const чистая = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * @param {object} api
 * @param {() => boolean} api.isUnsaved есть ли несохранённая работа
 * @param {() => void} api.markSaved работа сохранена
 * @param {() => Promise<number>} api.saveProject сохранить проект (0 — не сохранили)
 * @param {(label: string) => Promise<'save'|'discard'|'cancel'>} api.askSave вопрос о несохранённом
 * @param {(buf: ArrayBuffer, name: string) => Promise<boolean>} api.openBuffer
 * @param {(stem: string, meta: object|null) => Promise<{model: Uint8Array, extras: object[], project: Uint8Array|null}>} api.build
 * @param {(text: string) => void} api.hint строка состояния
 * @param {{onModelReplaced?: Function}} api.viewport
 */
export function createLevelMaker(api) {
  const host = window.painterHost?.job;
  let активное = null;      // { id, label, caller, model, returnTo, hasProject, подпись, отправлено }
  let открываю = false;
  let отправляю = false;

  /* ── Полоса над видом ── */
  const полоса = document.createElement('div');
  полоса.id = 'lm-bar';
  полоса.hidden = true;
  const откуда = document.createElement('span');
  откуда.className = 'lm-from';
  const имя = document.createElement('b');
  имя.className = 'lm-label';
  const отметка = document.createElement('span');
  отметка.className = 'lm-sent';
  const вернуть = document.createElement('button');
  вернуть.className = 'btn accent';
  вернуть.id = 'lm-return';
  const отменить = document.createElement('button');
  отменить.className = 'btn';
  отменить.id = 'lm-cancel';
  полоса.append(откуда, имя, отметка, вернуть, отменить);
  document.getElementById('viewport').appendChild(полоса);
  вернуть.addEventListener('click', () => отправить());
  отменить.addEventListener('click', () => отказаться());

  /** Надписи — из словаря при каждом показе и смене языка (время — датой, не строкой). */
  function sync() {
    const j = активное;
    полоса.hidden = !j;
    document.getElementById('viewport').classList.toggle('lm-on', !!j);
    if (!j) return;
    откуда.textContent = t('lm.from', j.caller);
    имя.textContent = j.label;
    отметка.textContent = j.отправлено
      ? t('lm.sent', j.caller, j.отправлено.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' }))
      : '';
    вернуть.textContent = t('lm.return', j.caller);
    вернуть.title = t('lm.returnTip', j.caller);
    вернуть.disabled = отправляю;
    отменить.textContent = t('lm.cancel');
    отменить.title = t('lm.cancelTip', j.caller);
  }
  onLangChange(sync);

  const состояние = (id, st, код, подробно) => host.status(id, st, код, подробно).catch((e) => console.error(e));

  /* ── Задание пришло ── */
  async function принять(j) {
    // То же задание ещё открыто («Разукрасить» нажали снова) — продолжаем
    // начатое: перечитать модель значило бы потерять несохранённые мазки.
    if (активное && активное.model === j.model && активное.returnTo === j.returnTo) {
      активное = { ...j, подпись: активное.подпись, отправлено: активное.отправлено };
      sync();
      await состояние(j.id, 'opened');
      return;
    }
    if (api.isUnsaved()) {
      const ответ = await api.askSave(j.label);
      const сохранено = ответ === 'save' ? await api.saveProject() : 1;
      if (ответ === 'cancel' || !сохранено) { await состояние(j.id, 'cancelled', 'ask-cancel'); return; }
    }
    if (активное) {
      const прежнее = активное;
      активное = null;
      sync();
      await состояние(прежнее.id, 'cancelled', 'other-job');
    }

    открываю = true;
    try {
      const модель = await host.read(j.id, 'model');
      if (!модель) throw new Error(j.model);
      const буфер = модель.bytes.buffer.slice(модель.bytes.byteOffset, модель.bytes.byteOffset + модель.bytes.byteLength);
      const подпись = await подписьМодели(буфер, модель.name);

      // Проект прошлой покраски — если он от этой же модели: слои и лицо
      // продолжаются. Чужой (модель в LevelMaker поменяли) — открываем модель.
      let открыто = false, чужойПроект = false;
      const проект = j.hasProject ? await host.read(j.id, 'project') : null;
      if (проект) {
        const meta = readProjectMeta(проект.bytes);
        if (таЖеПодпись(meta?.levelmaker?.signature, подпись)) {
          открыто = await api.openBuffer(проект.bytes.buffer.slice(проект.bytes.byteOffset, проект.bytes.byteOffset + проект.bytes.byteLength), проект.name);
        } else чужойПроект = true;
      }
      if (!открыто) открыто = await api.openBuffer(буфер, модель.name);
      if (!открыто) throw new Error(модель.name);
      if (чужойПроект) api.hint(t('lm.projectOther'));

      активное = { ...j, подпись, отправлено: null };
      api.markSaved();
      sync();
      await состояние(j.id, 'opened');
    } catch (e) {
      console.error(e);
      api.hint(t('lm.openFailed', j.label, чистая(e)));
      await состояние(j.id, 'failed', 'open-failed', чистая(e));
    } finally {
      открываю = false;
    }
  }

  /* ── Сохранить и вернуть ── */
  async function отправить() {
    const j = активное;
    if (!j || отправляю) return false;
    отправляю = true;
    sync();
    try {
      await withBusy('busy.levelmaker', async () => {
        const что = await api.build(основаИмени(j.returnTo), j.hasProject ? { signature: j.подпись } : null);
        await host.deliver(j.id, что);
      }, j.caller);
      j.отправлено = new Date();
      api.markSaved();
      return true;
    } catch (e) {
      console.error(e);
      api.hint(t('lm.failed', j.caller, чистая(e)));
      return false;
    } finally {
      отправляю = false;
      sync();
    }
  }

  /** «Отменить» в полосе: задание закрыто, модель остаётся обычной работой. */
  async function отказаться() {
    const j = активное;
    if (!j) return;
    активное = null;
    sync();
    await состояние(j.id, 'cancelled', 'user-cancel');
  }

  // Открыли другую модель (перетаскиванием, из недавних, демо) — задание закрыто.
  api.viewport.onModelReplaced = () => {
    if (открываю || !активное) return;
    const j = активное;
    активное = null;
    sync();
    состояние(j.id, 'cancelled', 'other-model');
  };

  // Задания идут по одному: вопрос о несохранённом и открытие не должны
  // перемешаться, если LevelMaker прислал два подряд.
  let цепочка = Promise.resolve();
  if (host) host.onIncoming((j) => { цепочка = цепочка.then(() => принять(j)); });

  return {
    active: () => !!активное,
    caller: () => активное?.caller || 'LevelMaker',
    send: отправить,
    cancel: отказаться,
    /** Для проверок: что сейчас открыто и когда отправлено. */
    info: () => (активное ? { id: активное.id, label: активное.label, sent: активное.отправлено?.toISOString() || null } : null),
    idle: () => цепочка,
  };
}

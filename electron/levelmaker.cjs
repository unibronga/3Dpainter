/**
 * Покраска из LevelMaker: договор `levelmaker-paint/1`.
 *
 * LevelMaker (редактор уровней ELTARAX) пишет маленький файл задания
 * `<имя>.levelmaker.json` и открывает им 3DPainter. Мы открываем модель,
 * а по кнопке «Сохранить и вернуть» кладём покрашенный GLB ровно туда, где
 * его ждут, и отвечаем файлом состояния. Ни сокетов, ни ключей: файл и
 * событие открытия одинаково работают на Mac и на Windows.
 *
 * Здесь — то, что не зависит от окна: разбор задания, атомарная запись и
 * файл состояния. Оболочка (`main.cjs`) только связывает это со страницей.
 *
 * 🔴 Задание называет пути, по которым мы будем писать. Файл мог прийти
 * откуда угодно, поэтому пишем только по своим окончаниям: модель — `.glb`,
 * проект — `.3dpaint`, состояние — `.json`. Чужой файл задание не перезапишет.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FORMAT = 'levelmaker-paint/1';
const JOB_SUFFIX = '.levelmaker.json';

/** Сообщения для файла состояния: договор просит их по-русски, для человека. */
const ПРИЧИНЫ = {
  'user-cancel': 'Покраску отменили в 3DPainter.',
  'ask-cancel': 'В 3DPainter была открыта другая несохранённая работа — открытие отменили.',
  'other-job': 'В 3DPainter открыли другое задание LevelMaker.',
  'other-model': 'В 3DPainter открыли другую модель.',
  'open-failed': 'Не удалось открыть модель в 3DPainter',
  'save-failed': 'Не удалось записать результат',
};

const isJobFile = (p) => typeof p === 'string' && p.toLowerCase().endsWith(JOB_SUFFIX);

/** Время с часовым поясом, как в договоре: 2026-10-11T14:32:05+03:00. */
function localIso(d = new Date()) {
  const z = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const сдвиг = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`
    + `${сдвиг >= 0 ? '+' : '-'}${z(сдвиг / 60)}:${z(сдвиг % 60)}`;
}

class JobError extends Error {
  /** @param {string} message причина по-русски @param {object|null} job что успели прочесть (для состояния) */
  constructor(message, job = null) { super(message); this.job = job; }
}

/**
 * Прочесть и проверить файл задания. Неизвестные поля пропускаются: LevelMaker
 * может добавить новые. Ошибка — JobError с тем, что удалось прочесть: если
 * путь состояния известен, туда уйдёт `failed`.
 */
function readJob(файл) {
  let текст;
  try { текст = fs.readFileSync(файл, 'utf8'); } catch (e) {
    throw new JobError(`Не удалось прочесть файл задания «${файл}»: ${e.message}`);
  }
  let j;
  try { j = JSON.parse(текст.replace(/^﻿/, '')); } catch (e) {
    throw new JobError(`Файл задания «${path.basename(файл)}» — не JSON: ${e.message}`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new JobError(`Файл задания «${path.basename(файл)}» пуст.`);

  const путь = (ключ, окончание, нужно = true) => {
    const v = j[ключ];
    if (v == null || v === '') {
      if (нужно) throw new JobError(`В задании нет поля «${ключ}».`, черновик);
      return null;
    }
    if (typeof v !== 'string' || !path.isAbsolute(v)) throw new JobError(`Поле «${ключ}» должно быть абсолютным путём.`, черновик);
    if (окончание && !v.toLowerCase().endsWith(окончание)) {
      throw new JobError(`Поле «${ключ}» должно оканчиваться на «${окончание}».`, черновик);
    }
    return path.normalize(v);
  };
  // Путь состояния — первым: дальше любая ошибка уже может уйти в него.
  const черновик = { status: null, return_to: '' };
  черновик.status = путь('status', '.json', false);
  if (j.format !== FORMAT) {
    throw new JobError(`Незнакомая версия договора «${j.format ?? '—'}»: 3DPainter понимает «${FORMAT}». Обновите 3DPainter или LevelMaker.`, черновик);
  }
  if (!черновик.status) throw new JobError('В задании нет поля «status».', черновик);
  const job = {
    file: path.resolve(файл),
    format: FORMAT,
    caller: typeof j.caller === 'string' && j.caller ? j.caller : 'LevelMaker',
    label: typeof j.label === 'string' && j.label.trim() ? j.label.trim() : path.basename(String(j.model || ''), path.extname(String(j.model || ''))),
    status: черновик.status,
    return_to: '',
    model: null, project: null, return_app: null,
  };
  Object.assign(черновик, job);
  job.return_to = черновик.return_to = путь('return_to', '.glb');
  job.model = путь('model', null);
  job.project = путь('project', '.3dpaint', false);
  job.return_app = typeof j.return_app === 'string' && j.return_app ? j.return_app : null;
  return job;
}

/** Записать атомарно: `<путь>.part`, потом переименование. Папки — создать. */
async function writeAtomic(куда, байты) {
  await fsp.mkdir(path.dirname(куда), { recursive: true });
  const part = куда + '.part';
  try {
    await fsp.writeFile(part, байты);
    await fsp.rename(part, куда);
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Файл состояния. Каждая запись заменяет его целиком. `file` — путь
 * результата, только у `saved`: у остальных результата нет.
 */
async function writeStatus(job, state, { message = '', version = '' } = {}) {
  if (!job?.status) return false;
  const тело = {
    format: FORMAT, state, time: localIso(),
    file: state === 'saved' ? job.return_to : '',
    painter_version: version, message,
  };
  await writeAtomic(job.status, Buffer.from(JSON.stringify(тело, null, 2) + '\n', 'utf8'));
  return тело;
}

/**
 * Сохранить и вернуть: спутники рядом с моделью, затем сама модель, затем
 * проект. Модель переименовывается последней — LevelMaker смотрит на неё и
 * на состояние, и к этому моменту спутники уже на месте.
 *
 * @param {{model: Uint8Array, extras?: {name: string, bytes: Uint8Array}[], project?: Uint8Array|null}} что
 */
async function deliver(job, что) {
  const папка = path.dirname(job.return_to);
  for (const { name, bytes } of что.extras || []) {
    const имя = path.basename(String(name).replace(/\\/g, '/'));
    if (!имя || имя.startsWith('.') || имя.toLowerCase().endsWith('.part')) throw new Error(`Недопустимое имя файла: «${name}».`);
    await writeAtomic(path.join(папка, имя), байтыИз(bytes));
  }
  await writeAtomic(job.return_to, байтыИз(что.model));
  if (job.project && что.project) await writeAtomic(job.project, байтыИз(что.project));
}

function байтыИз(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new Error('Страница передала не байты.');
}

/**
 * Какие файлы открыть из командной строки. Windows передаёт путь задания
 * аргументом (и второму экземпляру — тоже); на Mac так же приходит
 * `electron . файл` при разработке. Берём только существующие файлы нужных
 * окончаний — служебные ключи Chromium сюда не попадут.
 */
const OPENABLE = /\.(levelmaker\.json|3dpaint|glb|gltf|obj|fbx|dae|3mf|wrl|vrml|stl|ply|amf)$/i;
function filesFromArgv(argv, cwd = process.cwd()) {
  const out = [];
  for (const a of argv) {
    if (typeof a !== 'string' || !a || a.startsWith('-') || !OPENABLE.test(a)) continue;
    const p = path.resolve(cwd, a);
    try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* нет файла — не наш аргумент */ }
  }
  return out;
}

module.exports = { FORMAT, JOB_SUFFIX, ПРИЧИНЫ, JobError, isJobFile, readJob, writeAtomic, writeStatus, deliver, filesFromArgv, localIso };

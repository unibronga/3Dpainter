/**
 * Значок приложения: из исходной картинки — в build/icon.png.
 *
 * Исходник (build/icon-source.png) нарисован с белым полем вокруг. Для macOS
 * так нельзя: в Dock оно станет белой рамкой вокруг значка. Поэтому фон
 * выбирается заливкой от углов — по связной почти-белой области, а не по
 * «всем белым пикселям»: белые блики внутри рисунка трогать нельзя.
 *
 * Дальше рисунок обрезается по непрозрачному краю, вписывается в квадрат с
 * полями и режется по скруглённому квадрату: в macOS значок занимает не весь
 * холст и имеет скруглённые углы, иначе он выглядит крупнее системных и
 * выбивается из ряда.
 *
 * Считаем в Electron — он и так в зависимостях, а тянуть ради одной картинки
 * графическую библиотеку незачем. Запуск: npm run icon
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const КОРЕНЬ = path.resolve(__dirname, '..');
const ИСХОДНИК = path.join(КОРЕНЬ, 'build', 'icon-source.png');
const ВЫХОД = path.join(КОРЕНЬ, 'build', 'icon.png');

const РАЗМЕР = 1024;      // холст значка
const ПОЛЕ = 0.085;       // доля холста на поле с каждой стороны
const СКРУГЛЕНИЕ = 0.224; // радиус угла в долях стороны значка — как в macOS

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(ИСХОДНИК)) {
    console.error('[значок] нет исходника:', ИСХОДНИК);
    app.exit(1);
    return;
  }

  const окно = new BrowserWindow({ show: false, width: 200, height: 200 });
  await окно.loadURL('data:text/html,<meta charset="utf-8">');

  const данные = fs.readFileSync(ИСХОДНИК).toString('base64');

  const итог = await окно.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${данные}';
    await img.decode();

    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);

    const данныеПикселей = g.getImageData(0, 0, c.width, c.height);
    const d = данныеПикселей.data;
    const W = c.width, H = c.height;
    const почтиБелый = (i) => d[i] > 237 && d[i + 1] > 237 && d[i + 2] > 237;

    // Заливка от углов: убираем только фон, связный с краем картинки.
    const очередь = [];
    const посещено = new Uint8Array(W * H);
    const добавить = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const p = y * W + x;
      if (посещено[p]) return;
      посещено[p] = 1;
      if (!почтиБелый(p * 4)) return;
      d[p * 4 + 3] = 0;
      очередь.push(p);
    };
    for (let x = 0; x < W; x++) { добавить(x, 0); добавить(x, H - 1); }
    for (let y = 0; y < H; y++) { добавить(0, y); добавить(W - 1, y); }
    while (очередь.length) {
      const p = очередь.pop();
      const x = p % W, y = (p / W) | 0;
      добавить(x + 1, y); добавить(x - 1, y); добавить(x, y + 1); добавить(x, y - 1);
    }
    g.putImageData(данныеПикселей, 0, 0);

    // Границы того, что осталось непрозрачным.
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const ш = x1 - x0 + 1, в = y1 - y0 + 1;

    // Вписываем в квадрат с полями.
    const out = document.createElement('canvas');
    out.width = out.height = ${РАЗМЕР};
    const og = out.getContext('2d');
    og.imageSmoothingQuality = 'high';
    const доступно = ${РАЗМЕР} * (1 - ${ПОЛЕ} * 2);
    const k = доступно / Math.max(ш, в);
    const нш = ш * k, нв = в * k;
    const левый = (${РАЗМЕР} - нш) / 2, верхний = (${РАЗМЕР} - нв) / 2;

    // Режем по скруглённому квадрату: прямые углы в Dock смотрятся чужими.
    const радиус = Math.min(нш, нв) * ${СКРУГЛЕНИЕ};
    og.save();
    og.beginPath();
    og.roundRect(левый, верхний, нш, нв, радиус);
    og.clip();
    og.drawImage(c, x0, y0, ш, в, левый, верхний, нш, нв);
    og.restore();

    return JSON.stringify({
      исходный: [W, H],
      обрезано: [ш, в],
      png: out.toDataURL('image/png').split(',')[1],
    });
  })()`);

  const { исходный, обрезано, png } = JSON.parse(итог);
  fs.writeFileSync(ВЫХОД, Buffer.from(png, 'base64'));
  const кб = (fs.statSync(ВЫХОД).size / 1024).toFixed(0);
  console.log(`[значок] ${исходный.join('×')} → обрезано ${обрезано.join('×')} → ${ВЫХОД} (${РАЗМЕР}×${РАЗМЕР}, ${кб} КБ)`);
  app.exit(0);
});

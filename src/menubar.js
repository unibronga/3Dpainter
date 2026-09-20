/**
 * Меню программы. Описывается данными, а не разметкой: пункты дублируют
 * действия панелей, и держать их в одном списке дешевле, чем разносить по
 * коду и потом искать, где какой отстал.
 *
 * Пункт: { label, hint, action, checked?, radio?, disabled? }
 * Разделитель: строка '-'
 *
 * `title` и `label` бывают функциями: так надписи переживают смену языка —
 * достаточно вызвать relabel(), не пересобирая меню и не теряя состояние.
 */

/** Надпись бывает строкой или функцией, возвращающей строку. */
const надпись = (что) => (typeof что === 'function' ? что() : что);

export class MenuBar {
  /**
   * @param {HTMLElement} container
   * @param {{title: string, items: Array}[]} menus
   */
  constructor(container, menus) {
    this.container = container;
    this.menus = menus;
    this.open = -1;
    this.els = [];

    menus.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-title';
      btn.textContent = надпись(m.title);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggle(i);
      });
      // Когда меню уже раскрыто, наведение перекидывает на соседнее —
      // привычное поведение любой строки меню.
      btn.addEventListener('pointerenter', () => { if (this.open >= 0 && this.open !== i) this.show(i); });

      const drop = document.createElement('div');
      drop.className = 'menu-drop';

      container.appendChild(btn);
      container.appendChild(drop);
      this.els.push({ btn, drop });
      this._fill(i);
    });

    document.addEventListener('pointerdown', (e) => {
      if (this.open < 0) return;
      // Целью события может быть не узел (например, само окно) — contains()
      // на таком аргументе бросает исключение.
      const t = e.target;
      const inDrop = t instanceof Node && this.els[this.open].drop.contains(t);
      if (!inDrop) this.close();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    window.addEventListener('blur', () => this.close());
  }

  _fill(i) {
    const { drop } = this.els[i];
    drop.innerHTML = '';

    for (const item of this.menus[i].items) {
      if (item === '-') {
        const hr = document.createElement('div');
        hr.className = 'menu-sep';
        drop.appendChild(hr);
        continue;
      }

      const row = document.createElement('button');
      row.className = 'menu-item';

      const mark = document.createElement('span');
      mark.className = 'mark';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = надпись(item.label);

      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = item.hint || '';

      row.append(mark, label, hint);
      row.addEventListener('pointerdown', (e) => e.stopPropagation());
      row.addEventListener('click', () => {
        if (row.classList.contains('disabled')) return;
        this.close();
        item.action();
      });

      item._row = row;
      drop.appendChild(row);
    }
  }

  /** Перечитать надписи: смена языка меняет тексты, но не структуру меню. */
  relabel() {
    this.menus.forEach((m, i) => {
      this.els[i].btn.textContent = надпись(m.title);
      for (const item of m.items) {
        if (item === '-' || !item._row) continue;
        item._row.querySelector('.label').textContent = надпись(item.label);
      }
    });
  }

  /** Обновить галочки и доступность — вызывается перед показом. */
  refresh() {
    for (const m of this.menus) {
      for (const item of m.items) {
        if (item === '-' || !item._row) continue;
        const row = item._row;
        const on = item.checked ? item.checked() : (item.radio ? item.radio() : false);
        row.classList.toggle('checked', !!on);
        row.classList.toggle('radio', !!item.radio);
        row.querySelector('.mark').textContent = on ? (item.radio ? '•' : '✓') : '';
        row.classList.toggle('disabled', item.disabled ? !!item.disabled() : false);
      }
    }
  }

  show(i) {
    this.refresh();
    this.els.forEach(({ btn, drop }, k) => {
      const on = k === i;
      btn.classList.toggle('open', on);
      drop.classList.toggle('open', on);
      if (on) drop.style.left = btn.offsetLeft + 'px';
    });
    this.open = i;
  }

  toggle(i) { if (this.open === i) this.close(); else this.show(i); }

  close() {
    this.els.forEach(({ btn, drop }) => { btn.classList.remove('open'); drop.classList.remove('open'); });
    this.open = -1;
  }
}

// Thumbnail grid used by Organize, Rotate, Remove and Extract.
import { loadPdfJs, openBytes, renderPage } from './lib.js';
import { el, sortable } from './ui.js';

export async function pageGrid(host, { files }, { mode, selectLabel }) {
  const entries = [];
  const selected = new Set();
  const toolbar = el('div', { class: 'grid-tools' });
  const grid = el('div', { class: 'page-grid', role: 'list' });
  host.append(toolbar, grid);

  const io = new IntersectionObserver((seen) => {
    for (const s of seen) if (s.isIntersecting) { io.unobserve(s.target); s.target.draw?.(); }
  }, { rootMargin: '300px' });

  const applyTurn = (entry) => { entry.thumb.style.transform = `rotate(${entry.rotate}deg)`; };

  const card = (entry) => {
    const thumb = el('div', { class: 'thumb' });
    entry.thumb = thumb;
    const label = el('span', { class: 'page-label' });
    const node = el('div', { class: 'page-card', role: 'listitem', 'data-page': entry.index ?? 'blank' }, thumb, label);
    entry.node = node; entry.label = label;

    if (mode === 'select') {
      node.tabIndex = 0;
      node.setAttribute('role', 'checkbox');
      node.setAttribute('aria-checked', 'false');
      const toggle = () => {
        const on = !selected.has(entry.index);
        if (on) selected.add(entry.index); else selected.delete(entry.index);
        node.classList.toggle('picked', on);
        node.setAttribute('aria-checked', on);
        count();
      };
      node.addEventListener('click', toggle);
      node.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
    } else {
      const turn = (by) => { entry.rotate = (entry.rotate + by + 360) % 360; applyTurn(entry); };
      const actions = el('div', { class: 'card-actions' });
      actions.append(el('button', { type: 'button', title: 'Rotate left', 'aria-label': 'Rotate left', onclick: () => turn(-90) }, '↺'));
      actions.append(el('button', { type: 'button', title: 'Rotate right', 'aria-label': 'Rotate right', class: 'turn-right', onclick: () => turn(90) }, '↻'));
      if (mode === 'arrange') {
        actions.append(el('button', { type: 'button', title: 'Move earlier', 'aria-label': 'Move earlier', class: 'move-prev', onclick: () => { node.previousElementSibling?.before(node); renumber(); } }, '←'));
        actions.append(el('button', { type: 'button', title: 'Move later', 'aria-label': 'Move later', class: 'move-next', onclick: () => { node.nextElementSibling?.after(node); renumber(); } }, '→'));
        actions.append(el('button', { type: 'button', title: 'Delete page', 'aria-label': 'Delete page', class: 'delete-page', onclick: () => { node.remove(); entries.splice(entries.indexOf(entry), 1); renumber(); } }, '×'));
      }
      node.append(actions);
    }
    return node;
  };

  const renumber = () => {
    [...grid.children].forEach((n, i) => { entries.find((e) => e.node === n).label.textContent = i + 1; });
  };

  const counter = el('span', { class: 'muted', 'aria-live': 'polite' });
  const count = () => { counter.textContent = `${selected.size} selected`; };

  for (const file of files) {
    const doc = await loadPdfJs(await openBytes(file));
    for (let index = 0; index < doc.numPages; index++) {
      const entry = { file, index, rotate: 0 };
      const node = card(entry);
      node.draw = async () => {
        const page = await doc.getPage(index + 1);
        const scale = 150 / page.getViewport({ scale: 1 }).width;
        entry.thumb.append(await renderPage(page, Math.min(scale * (devicePixelRatio || 1), 1)));
      };
      entries.push(entry);
      grid.append(node);
      io.observe(node);
    }
  }
  renumber();

  if (mode === 'select') {
    toolbar.append(
      el('span', { class: 'muted' }, `Click pages to ${selectLabel.toLowerCase()}.`), counter,
      el('button', { type: 'button', class: 'link', onclick: () => {
        for (const e of entries) { selected.add(e.index); e.node.classList.add('picked'); e.node.setAttribute('aria-checked', 'true'); }
        count();
      } }, 'Select all'),
      el('button', { type: 'button', class: 'link', onclick: () => {
        selected.clear();
        for (const e of entries) { e.node.classList.remove('picked'); e.node.setAttribute('aria-checked', 'false'); }
        count();
      } }, 'Clear'),
    );
    count();
  } else {
    const all = (by) => { for (const e of entries) { e.rotate = (e.rotate + by + 360) % 360; applyTurn(e); } };
    toolbar.append(
      el('button', { type: 'button', class: 'ghost', onclick: () => all(-90) }, '↺ All left'),
      el('button', { type: 'button', class: 'ghost', id: 'rotate-all', onclick: () => all(90) }, '↻ All right'),
    );
    if (mode === 'arrange') {
      toolbar.append(el('button', { type: 'button', class: 'ghost', id: 'add-blank', onclick: () => {
        const entry = { blank: true, rotate: 0, width: 595.28, height: 841.89 };
        entries.push(entry);
        grid.append(card(entry));
        entry.thumb.classList.add('blank');
        renumber();
      } }, '+ Blank page'));
      sortable(grid, '.page-card', renumber);
    }
  }

  return {
    selected: () => selected,
    pages: () => [...grid.children].map((n) => entries.find((e) => e.node === n)),
  };
}

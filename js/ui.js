// Small DOM helpers shared by the app shell and the interactive tools.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

// Pointer-based reordering so it works with touch as well as a mouse.
export function sortable(container, selector, onChange) {
  let drag = null;
  container.addEventListener('pointerdown', (e) => {
    const item = e.target.closest(selector);
    if (!item || e.target.closest('button, input, select') || e.button) return;
    drag = { item, x: e.clientX, y: e.clientY, active: false, id: e.pointerId };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
      drag.active = true;
      drag.item.classList.add('dragging');
      container.classList.add('sorting');
    }
    e.preventDefault();
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(selector);
    if (!under || under === drag.item || !container.contains(under)) return;
    const r = under.getBoundingClientRect();
    const after = r.width > container.clientWidth * 0.8 ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    under[after ? 'after' : 'before'](drag.item);
  });
  const end = () => {
    if (drag?.active) {
      drag.item.classList.remove('dragging');
      container.classList.remove('sorting');
      onChange();
    }
    drag = null;
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

export function modal({ title, body, confirm = 'Continue', cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'modal' });
    const form = el('form', { method: 'dialog' }, el('h2', {}, title), body,
      el('div', { class: 'modal-actions' },
        el('button', { value: 'cancel', type: 'button', class: 'ghost', onclick: () => { dlg.close(); } }, cancel),
        el('button', { value: 'ok', type: 'submit', class: 'primary' }, confirm)));
    let ok = false;
    form.addEventListener('submit', () => { ok = true; });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(ok); });
    dlg.append(form);
    document.body.append(dlg);
    dlg.showModal();
  });
}

import { UserError, formatSize, jszip, setPasswordPrompt } from './lib.js';
import { el, modal, sortable } from './ui.js';
import { ICONS } from './icons.js';
import pages from './tools/pages.js';
import edit from './tools/edit.js';
import convert from './tools/convert.js';
import security from './tools/security.js';
import formats from './tools/formats.js';
import images from './tools/images.js';

const PDF_TOOLS = [...pages, ...edit, ...convert, ...formats, ...security];
const TOOLS = [...PDF_TOOLS.map((t) => Object.assign(t, { space: 'pdf' })), ...images.map((t) => Object.assign(t, { space: 'img' }))];

const SPACES = {
  pdf: {
    path: '#/', title: 'Serious PDF Tools, Zero Uploads', noun: 'documents',
    sub: 'Convert, edit and protect documents right in your browser. Your files never leave this device.',
    cats: [['organize', 'Organize'], ['optimize', 'Optimize'], ['convert', 'Convert'], ['edit', 'Edit'], ['security', 'Security']],
  },
  img: {
    path: '#/img', title: 'Serious Image Tools, Zero Uploads', noun: 'images',
    sub: 'Compress, edit, convert and retouch pictures right in your browser. Your files never leave this device.',
    cats: [['optimize', 'Optimize'], ['create', 'Create'], ['edit', 'Edit'], ['convert', 'Convert'], ['security', 'Security']],
  },
};

// These tools take several files and run once per file.
const BATCH = [
  'watermark', 'numbers', 'compress', 'repair', 'ocr', 'pdfa', 'protect', 'unlock', 'pdf-to-word', 'pdf-to-ppt', 'pdf-to-excel',
  'pdf-to-jpg', 'word-to-pdf', 'ppt-to-pdf', 'excel-to-pdf', 'epub-to-pdf', 'azw3-to-pdf', 'pdf-to-epub', 'pdf-to-azw3',
  'epub-to-azw3', 'azw3-to-epub', 'pdf-to-text', 'pdf-to-markdown', 'pdf-to-html', 'pdf-to-csv', 'odt-to-pdf', 'rtf-to-pdf',
];
for (const tool of TOOLS) if (BATCH.includes(tool.id)) Object.assign(tool, { multiple: true, batch: true });

async function runBatch(tool, { files, progress, report, ...rest }) {
  const results = [], lines = [];
  let one = null;
  for (const [i, file] of files.entries()) {
    const step = (p, text) => progress((i + p) / files.length, `${files.length > 1 ? `${file.name}: ` : ''}${text ?? ''}`);
    let summary = null;
    const out = await tool.run({ ...rest, files: [file], progress: step, report: (r) => { summary = r; } });
    results.push(...out);
    if (summary) { one = summary; lines.push(`${file.name}: ${summary.title}. ${summary.lines.join(' ')}`); }
  }
  if (one) report(files.length === 1 ? one : { title: `${files.length} files done`, lines });
  return results;
}
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');
let handoff = null;

const icon = (name) => el('span', { class: 'icon', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24">${ICONS[name] || ICONS.page}</svg>` });

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 6000);
}

const friendly = (e) => (e instanceof UserError ? e.message : `Something went wrong: ${e?.message || e}`);
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(friendly(e.reason)); });
window.addEventListener('error', (e) => { if (e.error) { console.error(e.error); toast(friendly(e.error)); } });

setPasswordPrompt(async (name, wrong) => {
  const input = el('input', { type: 'password', id: 'pdf-password', autocomplete: 'off', 'aria-label': 'Password', required: true });
  const ok = await modal({
    title: wrong ? 'That password was wrong' : 'This PDF is protected',
    body: el('div', { class: 'stack' }, el('p', {}, `Enter the password for ${name}. It is used only in this tab.`), input),
    confirm: 'Open',
  });
  return ok ? input.value : null;
});

/* ---------- home ---------- */

function home(space) {
  const info = SPACES[space], own = TOOLS.filter((t) => t.space === space);
  document.title = space === 'img' ? 'Image tools · myswisstools' : 'myswisstools';
  const search = el('input', { type: 'search', id: 'tool-search', placeholder: `Search ${own.length} tools`, 'aria-label': 'Search tools', autocomplete: 'off' });
  const groups = el('div', { class: 'groups' });
  const empty = el('p', { class: 'muted', hidden: true }, 'No tool matches that search.');

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const sections = info.cats.map(([id, label]) => {
      const list = own.filter((t) => t.cat === id && `${t.name} ${t.desc} ${t.id}`.toLowerCase().includes(q));
      if (!list.length) return null;
      return el('section', { class: 'group' }, el('h2', {}, label, el('span', {}, list.length)),
        el('div', { class: 'tool-grid' }, list.map((t) => el('a', { class: 'tool-card', href: `#/${t.id}`, title: t.desc },
          icon(t.icon), el('span', { class: 'tool-text' }, t.name, el('code', {}, `${id}/${t.id}`))))));
    }).filter(Boolean);
    groups.replaceChildren(...sections);
    empty.hidden = sections.length > 0;
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') groups.querySelector('a')?.click(); });
  draw();
  root.replaceChildren(
    el('section', { class: 'hero' },
      el('h1', {}, info.title),
      el('p', {}, info.sub),
      el('label', { class: 'search-wrap' }, search, el('kbd', {}, '⌘K')),
      el('dl', { class: 'stats' },
        el('div', {}, el('dd', {}, String(own.length)), el('dt', {}, 'Tools')),
        el('div', {}, el('dd', {}, '0'), el('dt', {}, 'Files uploaded')),
        el('div', {}, el('dd', {}, '0'), el('dt', {}, 'Accounts needed')),
        el('div', {}, el('dd', {}, 'Yes'), el('dt', {}, 'Works offline')))),
    groups, empty);
}

// ⌘K / Ctrl+K jumps to search from anywhere.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  const open = TOOLS.find((t) => t.id === location.hash.replace(/^#\/?/, ''));
  if (open) location.hash = SPACES[open.space].path;
  setTimeout(() => document.getElementById('tool-search')?.focus());
});

/* ---------- tool page ---------- */

function field(f, values, refresh) {
  const id = `f-${f.key}`;
  const set = (v) => { values[f.key] = v; refresh(); };
  let input;
  if (f.type === 'select') {
    input = el('select', { id, oninput: (e) => set(e.target.value) }, f.options.map(([v, t]) => el('option', { value: v, selected: v === f.default }, t)));
  } else if (f.type === 'checkbox') {
    input = el('input', { id, type: 'checkbox', checked: f.default, oninput: (e) => set(e.target.checked) });
    return { node: el('label', { class: 'check', 'data-key': f.key }, input, ` ${f.label}`), input };
  } else if (f.type === 'textarea') {
    input = el('textarea', { id, rows: 7, placeholder: f.placeholder, spellcheck: false, oninput: (e) => set(e.target.value) });
  } else if (f.type === 'file') {
    input = el('input', { id, type: 'file', accept: f.accept, oninput: (e) => set(e.target.files[0]) });
  } else if (f.type === 'range') {
    const out = el('output', {}, `${f.default}${f.unit}`);
    input = el('input', { id, type: 'range', min: f.min, max: f.max, value: f.default, oninput: (e) => { out.textContent = `${e.target.value}${f.unit}`; set(+e.target.value); } });
    return { node: el('div', { class: 'field', 'data-key': f.key }, el('label', { htmlFor: id }, f.label, ' ', out), input), input };
  } else {
    input = el('input', {
      id, type: f.type, value: f.default ?? '', placeholder: f.placeholder, min: f.min, max: f.max, autocomplete: f.autocomplete,
      oninput: (e) => set(e.target.value),
    });
  }
  return { node: el('div', { class: 'field', 'data-key': f.key }, el('label', { htmlFor: id }, f.label), input, f.hint && el('small', {}, f.hint)), input };
}

function toolPage(tool) {
  document.title = `${tool.name} · myswisstools`;
  let files = [];
  const head = el('header', { class: 'tool-head' }, el('a', { class: 'back', href: SPACES[tool.space].path }, '← All tools'),
    el('div', { class: 'tool-title' }, icon(tool.icon), el('div', {}, el('h1', {}, tool.name), el('p', {}, tool.desc))));
  const body = el('div', { class: 'tool-body' });
  root.replaceChildren(head, body);

  const addFiles = (list) => {
    const fresh = [...list];
    if (!fresh.length) return;
    files = tool.multiple ? [...files, ...fresh] : [fresh[0]];
    if (tool.maxFiles) files = files.slice(0, tool.maxFiles);
    workspace();
  };

  const picker = el('input', {
    type: 'file', accept: tool.accept, multiple: tool.multiple, id: 'file-input', class: 'visually-hidden',
    'aria-label': 'Choose files',
    onchange: (e) => { addFiles(e.target.files); e.target.value = ''; },
  });

  const dropTarget = (node) => {
    for (const ev of ['dragenter', 'dragover']) node.addEventListener(ev, (e) => { e.preventDefault(); node.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) node.addEventListener(ev, (e) => { e.preventDefault(); node.classList.remove('over'); });
    node.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  };

  const drop = () => {
    const zone = el('label', { class: 'drop', htmlFor: 'file-input' },
      icon('upload'), el('strong', {}, tool.multiple ? 'Choose files' : 'Choose a file'), el('span', {}, 'or drop here'),
      el('small', {}, 'Stays on this device'));
    dropTarget(zone);
    return zone;
  };

  const start = () => {
    if (handoff) {
      const f = handoff;
      handoff = null;
      addFiles([f]);
    } else if (tool.optionalFiles) workspace();
    else body.replaceChildren(...[picker, drop(), tool.note && el('p', { class: 'note' }, tool.note)].filter(Boolean));
  };

  function fileList() {
    const list = el('ol', { class: 'file-list' });
    const draw = () => {
      list.replaceChildren(...files.map((f, i) => {
        const row = el('li', { class: 'file-row' }, tool.multiple ? el('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿') : null,
          el('span', { class: 'file-name' }, f.name), el('span', { class: 'muted' }, formatSize(f.size)));
        row.file = f;
        if (tool.multiple) {
          row.append(
            el('button', { type: 'button', class: 'mini', 'aria-label': `Move ${f.name} up`, disabled: i === 0, onclick: () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; draw(); } }, '↑'),
            el('button', { type: 'button', class: 'mini', 'aria-label': `Move ${f.name} down`, disabled: i === files.length - 1, onclick: () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; draw(); } }, '↓'));
        }
        row.append(el('button', { type: 'button', class: 'mini', 'aria-label': `Remove ${f.name}`, onclick: () => { files.splice(i, 1); if (files.length) workspace(); else start(); } }, '×'));
        return row;
      }));
    };
    draw();
    if (tool.multiple) sortable(list, '.file-row', () => { files = [...list.children].map((r) => r.file); draw(); });
    return list;
  }

  async function workspace() {
    const values = Object.fromEntries((tool.fields || []).map((f) => [f.key, f.default ?? '']));
    const main = el('div', { class: 'work-main' });
    const side = el('aside', { class: 'work-side' });
    const fields = new Map();
    let studio = null;
    const refresh = () => {
      for (const f of tool.fields || []) fields.get(f.key).node.hidden = f.show ? !f.show(values) : false;
      studio?.update?.(values);
    };
    for (const f of tool.fields || []) { fields.set(f.key, field(f, values, refresh)); side.append(fields.get(f.key).node); }
    refresh();

    const progressBar = el('progress', { max: 1, value: 0, hidden: true, 'aria-label': 'Progress' });
    const status = el('p', { class: 'status', 'aria-live': 'polite' });
    const go = el('button', { type: 'button', class: 'primary big', id: 'run' }, tool.action);
    if (tool.note) side.append(el('p', { class: 'note' }, tool.note));
    side.append(el('div', { class: 'run-bar' }, go, progressBar, status));

    if (!tool.studio || tool.multiple && !tool.studio) main.append(fileList());
    if (tool.multiple && !tool.studio) {
      main.append(picker, el('label', { class: 'ghost add-more', htmlFor: 'file-input' }, '+ Add more files'));
      dropTarget(main);
    } else if (!tool.studio && tool.optionalFiles) {
      main.append(picker, el('label', { class: 'ghost add-more', htmlFor: 'file-input' }, '+ Add a file'));
    }
    body.replaceChildren(el('div', { class: `work${tool.pinned ? ' pinned' : ''}` }, main, side));
    const setValues = (v) => {
      Object.assign(values, v);
      for (const [k, val] of Object.entries(v)) fields.get(k).input.value = val;
    };
    if (tool.studio) {
      if (tool.optionalFiles) main.append(picker, el('label', { class: 'ghost add-more', htmlFor: 'file-input' }, '+ Add photos'));
      const host = el('div', { class: 'studio' });
      main.append(host);
      status.textContent = 'Opening document…';
      go.disabled = true;
      try { studio = await tool.studio(host, { files, values, setValues }); status.textContent = ''; go.disabled = false; }
      catch (e) { console.error(e); status.textContent = ''; toast(friendly(e)); start(); return; }
    }
    if (tool.init) {
      await tool.init({ files, setValues }).catch((e) => toast(friendly(e)));
    }

    go.addEventListener('click', async () => {
      const min = tool.minFiles || 1;
      if (!tool.optionalFiles && files.length < min) { toast(`Add at least ${min} files.`); return; }
      go.disabled = true;
      progressBar.hidden = false;
      progressBar.value = 0;
      let summary = null;
      const progress = (p, text) => { progressBar.value = p; if (text) status.textContent = text; };
      try {
        const input = { files, values, studio, progress, report: (r) => { summary = r; } };
        const results = await (tool.batch ? runBatch(tool, input) : tool.run(input));
        showResults(results, summary);
      } catch (e) {
        console.error(e);
        toast(friendly(e));
      } finally {
        go.disabled = false;
        progressBar.hidden = true;
        status.textContent = '';
      }
    });
  }

  function showResults(results, summary) {
    const items = results.map((r) => {
      const blob = new Blob([r.bytes], { type: r.type });
      return { ...r, blob, url: URL.createObjectURL(blob) };
    });
    const row = (r) => {
      const li = el('li', {}, r.type.startsWith('image/') ? el('img', { class: 'result-thumb', src: r.url, alt: '' }) : null,
        el('span', { class: 'file-name' }, r.name), el('span', { class: 'muted' }, formatSize(r.blob.size)),
        el('a', { class: 'ghost download', href: r.url, download: r.name }, 'Download'));
      // On phones this is how a result reaches Photos or another app.
      const file = new File([r.blob], r.name, { type: r.type });
      if (navigator.canShare?.({ files: [file] })) {
        li.append(el('button', { type: 'button', class: 'ghost share', onclick: () => navigator.share({ files: [file] }).catch(() => {}) }, 'Share'));
      }
      return li;
    };
    const list = el('ul', { class: 'results' }, items.map(row));
    const panel = el('section', { class: 'done', id: 'results', tabIndex: -1 },
      el('h2', {}, summary?.title || (items.length > 1 ? `${items.length} files ready` : 'Your file is ready')),
      summary?.lines.map((l) => el('p', { class: 'summary-line' }, l)), list);

    if (items.length > 1) {
      panel.append(el('button', { type: 'button', class: 'primary', id: 'zip-all', onclick: async (e) => {
        e.currentTarget.disabled = true;
        const JSZip = await jszip();
        const zip = new JSZip();
        items.forEach((r) => zip.file(r.name, r.blob));
        const blob = await zip.generateAsync({ type: 'blob' });
        el('a', { href: URL.createObjectURL(blob), download: 'myswisstools.zip' }).click();
      } }, 'Download all as ZIP'));
    } else if (/pdf|image/.test(items[0].type)) {
      const isImage = items[0].type.startsWith('image/');
      const options = TOOLS.filter((t) => t.id !== tool.id && t.accept.includes(isImage ? 'image/' : 'pdf'));
      const select = el('select', { 'aria-label': 'Next tool' }, options.map((t) => el('option', { value: t.id }, t.name)));
      panel.append(el('div', { class: 'next' }, el('span', {}, 'Keep going with'), select,
        el('button', { type: 'button', class: 'ghost', onclick: () => {
          handoff = new File([items[0].blob], items[0].name, { type: items[0].type });
          location.hash = `#/${select.value}`;
        } }, 'Open')));
    }
    panel.append(el('button', { type: 'button', class: 'link', onclick: () => { files = []; start(); } }, 'Start over'));
    document.getElementById('results')?.remove();
    body.append(panel);
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  start();
}

/* ---------- routing ---------- */

function route() {
  const id = location.hash.replace(/^#\/?/, '');
  const tool = TOOLS.find((t) => t.id === id);
  const space = tool?.space ?? (id === 'img' ? 'img' : 'pdf');
  document.querySelectorAll('.space-pill a').forEach((a) => {
    if (a.dataset.space === space) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (tool) toolPage(tool); else home(space);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode is optional */ });
}

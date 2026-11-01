import { UserError, formatSize, jszip, setPasswordPrompt } from './lib.js';
import { el, modal, sortable } from './ui.js';
import { ICONS } from './icons.js';
import pages from './tools/pages.js';
import edit from './tools/edit.js';
import convert from './tools/convert.js';
import security from './tools/security.js';
import formats from './tools/formats.js';

const TOOLS = [...pages, ...edit, ...convert, ...formats, ...security];

// These tools take several files and run once per file.
const BATCH = [
  'watermark', 'numbers', 'compress', 'repair', 'ocr', 'pdfa', 'protect', 'unlock', 'pdf-to-word', 'pdf-to-ppt', 'pdf-to-excel',
  'pdf-to-jpg', 'word-to-pdf', 'ppt-to-pdf', 'excel-to-pdf', 'epub-to-pdf', 'azw3-to-pdf', 'pdf-to-epub', 'pdf-to-azw3',
  'epub-to-azw3', 'azw3-to-epub', 'pdf-to-text', 'pdf-to-markdown', 'pdf-to-html', 'pdf-to-csv', 'odt-to-pdf', 'rtf-to-pdf',
];
for (const tool of TOOLS) if (BATCH.includes(tool.id)) Object.assign(tool, { multiple: true, batch: true });

async function runBatch(tool, { files, progress, report, ...rest }) {
  const results = [], lines = [];
  for (const [i, file] of files.entries()) {
    const step = (p, text) => progress((i + p) / files.length, `${files.length > 1 ? `${file.name}: ` : ''}${text ?? ''}`);
    let summary = null;
    const out = await tool.run({ ...rest, files: [file], progress: step, report: (r) => { summary = r; } });
    results.push(...out);
    if (summary) lines.push(`${file.name}: ${summary.title}. ${summary.lines.join(' ')}`);
  }
  if (lines.length) report(files.length === 1 ? { title: 'Done', lines } : { title: `${files.length} files converted`, lines });
  return results;
}
const CATS = [
  ['organize', 'Organize'], ['optimize', 'Optimize'], ['convert', 'Convert'], ['edit', 'Edit'], ['security', 'Security'],
];
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

function home() {
  document.title = 'Mypdftools';
  const search = el('input', { type: 'search', id: 'tool-search', placeholder: `Search ${TOOLS.length} tools`, 'aria-label': 'Search tools', autocomplete: 'off' });
  const groups = el('div', { class: 'groups' });
  const empty = el('p', { class: 'muted', hidden: true }, 'No tool matches that search.');

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const sections = CATS.map(([id, label]) => {
      const list = TOOLS.filter((t) => t.cat === id && `${t.name} ${t.desc} ${t.id}`.toLowerCase().includes(q));
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
      el('h1', {}, 'Serious PDF Tools, Zero Uploads'),
      el('p', {}, 'Convert, edit and protect documents right in your browser. Your files never leave this device.'),
      el('label', { class: 'search-wrap' }, search, el('kbd', {}, '⌘K')),
      el('dl', { class: 'stats' },
        el('div', {}, el('dd', {}, String(TOOLS.length)), el('dt', {}, 'Tools')),
        el('div', {}, el('dd', {}, '0'), el('dt', {}, 'Files uploaded')),
        el('div', {}, el('dd', {}, '0'), el('dt', {}, 'Accounts needed')),
        el('div', {}, el('dd', {}, 'Yes'), el('dt', {}, 'Works offline')))),
    groups, empty);
}

// ⌘K / Ctrl+K jumps to search from anywhere.
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  if (location.hash.replace(/^#\/?/, '')) location.hash = '#/';
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
  document.title = `${tool.name} · Mypdftools`;
  let files = [];
  const head = el('header', { class: 'tool-head' }, el('a', { class: 'back', href: '#/' }, '← All tools'),
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
    const refresh = () => { for (const f of tool.fields || []) fields.get(f.key).node.hidden = f.show ? !f.show(values) : false; };
    for (const f of tool.fields || []) { fields.set(f.key, field(f, values, refresh)); side.append(fields.get(f.key).node); }
    refresh();

    const progressBar = el('progress', { max: 1, value: 0, hidden: true, 'aria-label': 'Progress' });
    const status = el('p', { class: 'status', 'aria-live': 'polite' });
    const go = el('button', { type: 'button', class: 'primary big', id: 'run' }, tool.action);
    if (tool.note) side.append(el('p', { class: 'note' }, tool.note));
    side.append(go, progressBar, status);

    if (!tool.studio || tool.multiple && !tool.studio) main.append(fileList());
    if (tool.multiple && !tool.studio) {
      main.append(picker, el('label', { class: 'ghost add-more', htmlFor: 'file-input' }, '+ Add more files'));
      dropTarget(main);
    } else if (!tool.studio && tool.optionalFiles) {
      main.append(picker, el('label', { class: 'ghost add-more', htmlFor: 'file-input' }, '+ Add a file'));
    }
    body.replaceChildren(el('div', { class: 'work' }, main, side));

    let studio = null;
    if (tool.studio) {
      if (tool.optionalFiles) main.append(picker, el('label', { class: 'ghost add-more', htmlFor: 'file-input' }, '+ Add photos'));
      const host = el('div', { class: 'studio' });
      main.append(host);
      status.textContent = 'Opening document…';
      go.disabled = true;
      try { studio = await tool.studio(host, { files }); status.textContent = ''; go.disabled = false; }
      catch (e) { console.error(e); status.textContent = ''; toast(friendly(e)); start(); return; }
    }
    if (tool.init) {
      await tool.init({
        files,
        setValues: (v) => {
          Object.assign(values, v);
          for (const [k, val] of Object.entries(v)) fields.get(k).input.value = val;
        },
      }).catch((e) => toast(friendly(e)));
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
    const list = el('ul', { class: 'results' }, items.map((r) => el('li', {},
      el('span', { class: 'file-name' }, r.name), el('span', { class: 'muted' }, formatSize(r.blob.size)),
      el('a', { class: 'ghost download', href: r.url, download: r.name }, 'Download'))));
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
        el('a', { href: URL.createObjectURL(blob), download: 'mypdftools.zip' }).click();
      } }, 'Download all as ZIP'));
    } else if (items[0].type === 'application/pdf') {
      const select = el('select', { 'aria-label': 'Next tool' }, TOOLS.filter((t) => t.accept.includes('pdf') && t.id !== tool.id).map((t) => el('option', { value: t.id }, t.name)));
      panel.append(el('div', { class: 'next' }, el('span', {}, 'Keep going with'), select,
        el('button', { type: 'button', class: 'ghost', onclick: () => {
          handoff = new File([items[0].blob], items[0].name, { type: 'application/pdf' });
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
  window.scrollTo(0, 0);
  if (tool) toolPage(tool); else home();
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode is optional */ });
}

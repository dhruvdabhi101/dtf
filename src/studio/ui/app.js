// dtf Studio front end. No framework and no build step: the Studio ships inside
// the package and must work offline, so this is plain DOM code organised as one
// small module per view, each with a mount() that builds its skeleton once and
// update functions that patch the dynamic regions (so typing is never
// interrupted by a re-render).

const TOKEN = document.querySelector('meta[name="dtf-token"]').content;

// ── Utilities ─────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-dtf-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

/** h('div.cls#id', {attrs}, ...children) — tiny DOM builder. */
function h(tag, attrs, ...children) {
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
/** Replaces an element's children; like replaceChildren but flattens arrays and skips nulls. */
function set(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
const svg = (d, cls = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = d;
  return s;
};
const ICON = {
  play: '<path d="M4 2.5v11l9-5.5z"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  up: '<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>',
  down: '<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/>',
  chev: '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  target: '<circle cx="8" cy="8" r="5.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  refresh: '<path d="M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3"/>',
};
const iconBtn = (icon, title, onclick, cls = '') => h(`button.icon-btn${cls ? `.${cls}` : ''}`, { title, 'aria-label': title, onclick }, svg(ICON[icon]));

function toast(message, kind = 'info', ms = 4200) {
  const el = h(`div.toast.${kind}`, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}
const fail = (err) => toast(err instanceof Error ? err.message : String(err), 'error', 7000);

const rel = (p) => (state.project && p?.startsWith(state.project.cwd) ? p.slice(state.project.cwd.length + 1) : p);
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};
const artifactUrl = (p) => `/artifacts?path=${encodeURIComponent(p)}&token=${TOKEN}`;
function debounce(fn, wait) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied', 'ok', 1500); } catch { toast('Copy failed', 'error'); }
}

// ── Syntax highlighting (enough for generated and hand-written specs) ──────

const KW = new Set('import export from const let var async await function return if else for of in new throw try catch finally class extends typeof true false null undefined describe test it beforeAll afterAll beforeEach afterEach'.split(' '));
function highlight(line) {
  const out = [];
  const re = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\/(?![*/])(?:[^/\\\n]|\\.)+\/[gimsuy]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(document.createTextNode(line.slice(last, m.index)));
    const [text] = m;
    let cls = null;
    if (m[1]) cls = 'tok-com';
    else if (m[2] || m[3]) cls = 'tok-str';
    else if (m[4]) cls = 'tok-num';
    else if (m[5]) cls = KW.has(text) ? 'tok-kw' : 'tok-fn';
    else if (m[6] && KW.has(text)) cls = 'tok-kw';
    out.push(cls ? h(`span.${cls}`, text) : document.createTextNode(text));
    last = m.index + text.length;
  }
  if (last < line.length) out.push(document.createTextNode(line.slice(last)));
  return out;
}
function codeBlock(source, { highlightLine, failLine } = {}) {
  const pre = h('pre.code');
  source.replace(/\n$/, '').split('\n').forEach((line, i) => {
    const n = i + 1;
    const cls = n === failLine ? '.hl-fail' : n === highlightLine ? '.hl' : '';
    pre.append(h(`span.ln${cls}`, { 'data-line': n }, ...highlight(line), '\n'));
  });
  return pre;
}

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  project: null,
  view: 'tests',
  connected: false,
  run: null,               // active run record (live)
  runOutput: [],           // console lines for the active/last run
  lastRunId: null,
  tests: { files: [], latest: {}, loading: false, error: null, filter: '', collapsed: new Set() },
  selected: null,          // { file, name, line }
  recorder: { recording: false, picking: false, steps: [], suggestions: [] },
  apps: [],
};

const views = {};
let current = null;

function setView(name) {
  if (!views[name]) name = 'tests';
  state.view = name;
  for (const a of document.querySelectorAll('.sidenav a')) {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  current?.unmount?.();
  const main = document.getElementById('main');
  set(main);
  current = views[name];
  current.mount(main);
}

// ── Top bar ───────────────────────────────────────────────────────────────

function renderProject() {
  const p = state.project;
  const el = document.getElementById('project');
  if (!p) return set(el);
  const platform = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[p.platform] ?? p.platform;
  set(el,
    h('strong', p.name),
    h('span.sep', '/'),
    h('span.pill' + (p.platformSupported ? '' : '.warn'), platform + (p.platformSupported ? '' : ' · no driver')),
    p.app ? h('span.app-path', { title: p.app }, rel(p.app) ?? p.app) : h('span.pill.warn', 'no app configured'),
  );
}

function renderRunIndicator() {
  const run = state.run;
  const ind = document.getElementById('run-indicator');
  document.getElementById('run-all').hidden = !!run;
  document.getElementById('stop-run').hidden = !run;
  ind.hidden = !run;
  if (run) {
    const done = run.results?.length ?? 0;
    set(ind, h('span.spinner'), h('span', run.current ? run.current : run.label), h('span.pill', `${done} done`));
  }
}

async function startRun(req) {
  try {
    state.runOutput = [];
    const record = await api('POST', '/api/runs', req);
    state.run = record;
    state.lastRunId = record.id;
    renderRunIndicator();
    current?.onRun?.();
  } catch (err) { fail(err); }
}

document.getElementById('run-all').addEventListener('click', () => startRun({ label: 'All tests' }));
document.getElementById('stop-run').addEventListener('click', () => api('POST', '/api/runs/cancel').catch(fail));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !state.run) {
    e.preventDefault();
    if (state.view === 'tests' && state.selected) views.tests.runSelected();
    else startRun({ label: 'All tests' });
  }
});

// ── Live events ───────────────────────────────────────────────────────────

function connect() {
  const es = new EventSource(`/api/events?token=${TOKEN}`);
  const conn = document.getElementById('conn');
  es.addEventListener('open', () => { state.connected = true; conn.classList.remove('down'); });
  es.addEventListener('error', () => { state.connected = false; conn.classList.add('down'); });
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    state.run = d.run;
    Object.assign(state.recorder, d.recorder);
    renderRunIndicator();
    markRecording();
    current?.onRecorder?.();
  });
  es.addEventListener('run', (e) => onRunEvent(JSON.parse(e.data)));
  es.addEventListener('live', (e) => onLiveEvent(JSON.parse(e.data)));
}

function onRunEvent({ runId, event }) {
  switch (event.type) {
    case 'status':
      if (event.record.status === 'running') {
        state.run = event.record;
        state.lastRunId = runId;
      } else {
        state.run = null;
        const s = event.record.summary;
        const kind = event.record.status === 'passed' ? 'ok' : event.record.status === 'cancelled' ? 'info' : 'error';
        toast(s ? `${event.record.label}: ${s.passed} passed${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}`
          : `${event.record.label}: ${event.record.status}`, kind);
        refreshLatest();
      }
      break;
    case 'test-start':
      if (state.run) state.run.current = event.name;
      state.runOutput.push({ cls: 'ev-dim', text: `▸ ${event.name}` });
      break;
    case 'test-done': {
      const r = event.result;
      if (state.run) { state.run.results = [...(state.run.results ?? []), r]; state.run.current = undefined; }
      state.tests.latest[`${r.file}::${r.name}`] = r.status;
      const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '○';
      state.runOutput.push({ cls: r.status === 'passed' ? 'ev-pass' : r.status === 'failed' ? 'ev-fail' : 'ev-dim', text: `${mark} ${r.name}  ${ms(r.durationMs)}` });
      if (r.error) state.runOutput.push({ cls: 'ev-fail', text: `    ${r.error.message}` });
      break;
    }
    case 'test-retry':
      state.runOutput.push({ cls: 'ev-dim', text: `↻ retry ${event.attempt}: ${event.name}` });
      break;
    case 'output':
      state.runOutput.push({ text: event.line });
      break;
    case 'error':
      state.runOutput.push({ cls: 'ev-fail', text: event.message });
      break;
  }
  if (state.runOutput.length > 3000) state.runOutput.splice(0, state.runOutput.length - 3000);
  renderRunIndicator();
  current?.onRun?.(event);
}

function markRecording() {
  document.querySelector('.sidenav a[data-view="record"]').classList.toggle('live', !!state.recorder.recording);
}

function onLiveEvent(e) {
  switch (e.type) {
    case 'recorder:state': Object.assign(state.recorder, e.state); break;
    case 'recorder:steps': state.recorder.steps = e.steps; break;
    case 'recorder:suggestion': state.recorder.suggestions = [...state.recorder.suggestions, e.suggestion]; break;
    case 'recorder:error': fail(e.message); break;
    case 'recorder:pick': if (state.view === 'record') views.record.showPick(e.pick); break;
    case 'inspect:pick': if (state.view === 'inspect') views.inspect.showPick(e.pick); break;
  }
  markRecording();
  current?.onRecorder?.(e);
}

async function refreshLatest() {
  try {
    const { files, latest } = await api('GET', '/api/tests');
    state.tests.files = files;
    state.tests.latest = latest;
    current?.onTests?.();
  } catch { /* shown on next explicit load */ }
}

// ── Modal ─────────────────────────────────────────────────────────────────

function openModal(build) {
  const dlg = document.getElementById('modal');
  const close = () => dlg.close();
  set(dlg, ...[build(close)].flat());
  dlg.showModal();
  return close;
}
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

// ═════════════════════════════════════════════════════════════════════════
// Tests view
// ═════════════════════════════════════════════════════════════════════════

views.tests = (() => {
  let root, explorer, detail, consoleBody, consoleWrap, filterInput;

  function mount(main) {
    filterInput = h('input.input', {
      type: 'search', placeholder: 'Filter tests…', value: state.tests.filter,
      oninput: (e) => { state.tests.filter = e.target.value; renderExplorer(); },
    });
    explorer = h('div');
    detail = h('div.pane-pad');
    consoleBody = h('div.console-body');
    consoleWrap = h('div.console', { hidden: true },
      h('div.console-head', h('strong', 'Output'), h('span.grow'),
        iconBtn('x', 'Hide output', () => { consoleWrap.hidden = true; }))
      , consoleBody);
    root = h('section.view',
      h('div.split',
        h('div.pane', h('div.explorer-filter', filterInput), explorer),
        h('div.pane', { style: { display: 'flex', flexDirection: 'column' } },
          h('div', { style: { flex: '1', overflow: 'auto' } }, detail),
          consoleWrap),
      ),
    );
    main.append(root);
    renderExplorer();
    renderDetail();
    renderConsole();
    load();
  }

  async function load() {
    state.tests.loading = true;
    state.tests.error = null;
    renderExplorer();
    try {
      const { files, latest } = await api('GET', '/api/tests');
      state.tests.files = files;
      state.tests.latest = latest;
    } catch (err) {
      state.tests.error = err.message;
    }
    state.tests.loading = false;
    renderExplorer();
    renderDetail();
  }

  function statusOf(file, name) {
    if (state.run?.current === name) return 'running';
    return state.tests.latest[`${file}::${name}`] ?? '';
  }

  function renderExplorer() {
    if (!explorer) return;
    const t = state.tests;
    if (t.loading && !t.files.length) return set(explorer, h('div.empty', h('span.spinner'), 'Collecting tests…'));
    if (t.error) return set(explorer, h('div.pane-pad', h('div.callout.fail', t.error)));
    if (!t.files.length) {
      return set(explorer, h('div.empty',
        h('h2', 'No tests yet'),
        h('p', 'Record one from the Record tab, or add *.spec.ts files matching testMatch in dtf.config.'),
        h('a.btn', { href: '#record' }, 'Record a test')));
    }
    const q = t.filter.trim().toLowerCase();
    const groups = [];
    for (const f of t.files) {
      const tests = f.tests.filter((x) => !q || x.fullName.toLowerCase().includes(q) || rel(f.file).toLowerCase().includes(q));
      if (q && !tests.length && !f.error) continue;
      const collapsed = t.collapsed.has(f.file) && !q;
      const statuses = tests.map((x) => statusOf(f.file, x.fullName));
      const fileStatus = statuses.includes('running') ? 'running' : statuses.includes('failed') ? 'failed'
        : statuses.length && statuses.every((s) => s === 'passed' || s === 'skipped') && statuses.includes('passed') ? 'passed' : '';
      groups.push(h(`div.file-group${collapsed ? '.collapsed' : ''}`,
        h('div.file-row', {
          onclick: () => { t.collapsed.has(f.file) ? t.collapsed.delete(f.file) : t.collapsed.add(f.file); renderExplorer(); },
          title: rel(f.file),
        },
        svg(ICON.chev, 'chev'),
        h(`span.dot${fileStatus ? `.${fileStatus}` : ''}`),
        h('span.name', rel(f.file)),
        h('span.actions', iconBtn('play', 'Run file', (e) => { e.stopPropagation(); startRun({ files: [f.file], label: rel(f.file) }); }, 'run'))),
        f.error ? h('div.file-error', f.error) : null,
        h('div.tests', tests.map((x) => {
          const sel = state.selected && state.selected.file === f.file && state.selected.name === x.fullName;
          const st = statusOf(f.file, x.fullName);
          return h('div.test-row', {
            'aria-selected': sel ? 'true' : 'false',
            onclick: () => select({ file: f.file, name: x.fullName, line: x.line }),
            title: x.fullName,
          },
          h(`span.dot${st ? `.${st}` : ''}`),
          h('span.name', x.fullName, x.skip ? h('span.pill', { style: { marginLeft: '6px' } }, 'skip') : null),
          x.line ? h('span.line-no', `:${x.line}`) : null,
          h('span.actions', iconBtn('play', 'Run test', (e) => { e.stopPropagation(); runTest(f.file, x); }, 'run')));
        })),
      ));
    }
    set(explorer, ...groups);
  }

  function runTest(file, x) {
    startRun({ files: [file], line: x.line, grep: x.line ? undefined : x.fullName, label: `${rel(file)} › ${x.fullName}` });
  }

  function runSelected() {
    const s = state.selected;
    if (!s) return;
    runTest(s.file, { fullName: s.name, line: s.line });
  }

  let sourceCache = { file: null, content: '' };
  let lastResult = null;

  async function select(sel) {
    state.selected = sel;
    renderExplorer();
    if (sourceCache.file !== sel.file) {
      try {
        const { content } = await api('GET', `/api/file?path=${encodeURIComponent(sel.file)}`);
        sourceCache = { file: sel.file, content };
      } catch (err) { sourceCache = { file: sel.file, content: `// ${err.message}` }; }
    }
    lastResult = await findLastResult(sel);
    renderDetail();
    detail.querySelector('.ln.hl, .ln.hl-fail')?.scrollIntoView({ block: 'center' });
  }

  async function findLastResult(sel) {
    try {
      const runs = await api('GET', '/api/runs');
      for (const r of runs.slice(0, 15)) {
        const full = await api('GET', `/api/runs/${r.id}`);
        const hit = full.results.find((x) => x.file === sel.file && x.name === sel.name);
        if (hit) return { ...hit, runAt: full.startedAt };
      }
    } catch { /* no history */ }
    return null;
  }

  function failLine(result, file) {
    const stack = result?.error?.stack ?? '';
    for (const line of stack.split('\n')) {
      const i = line.indexOf(file);
      if (i === -1) continue;
      const m = line.slice(i + file.length).match(/:(\d+):\d+/);
      if (m) return Number(m[1]);
    }
    return undefined;
  }

  function renderDetail() {
    if (!detail) return;
    const sel = state.selected;
    if (!sel) {
      const total = state.tests.files.reduce((a, f) => a + f.tests.length, 0);
      set(detail, h('div.empty',
        h('h2', total ? `${total} test${total === 1 ? '' : 's'} in ${state.tests.files.length} file${state.tests.files.length === 1 ? '' : 's'}` : 'dtf Studio'),
        h('p', 'Select a test to see its source and last result. ', h('span.kbd', '⌘/Ctrl ↵'), ' runs it.')));
      return;
    }
    const r = lastResult;
    const fl = r?.status === 'failed' ? failLine(r, sel.file) : undefined;
    set(detail,
      h('div.detail-head',
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('h2', sel.name),
          h('div.path', `${rel(sel.file)}${sel.line ? `:${sel.line}` : ''}`)),
        r ? h(`span.pill.${r.status === 'passed' ? 'pass' : r.status === 'failed' ? 'fail' : 'warn'}`, `${r.status} · ${ms(r.durationMs)} · ${ago(r.runAt)}`) : h('span.pill', 'not run yet'),
        h('button.btn.btn-primary', { onclick: runSelected, disabled: !!state.run }, svg(ICON.play), 'Run'),
      ),
      r?.error ? h('div.error-box',
        h('pre.msg', r.error.message),
        r.error.stack ? h('details', h('summary', 'Stack trace'), h('pre', r.error.stack)) : null) : null,
      r && (r.screenshot || r.treeDump || r.appLog) ? h('div.artifacts',
        r.screenshot ? h('a.shot', { href: artifactUrl(r.screenshot), target: '_blank' }, h('img', { src: artifactUrl(r.screenshot), alt: 'Screenshot at failure', loading: 'lazy' })) : null,
        h('div.artifact-links',
          r.treeDump ? h('a.btn.btn-sm', { href: artifactUrl(r.treeDump), target: '_blank' }, 'Accessibility tree') : null,
          r.appLog ? h('a.btn.btn-sm', { href: artifactUrl(r.appLog), target: '_blank' }, 'App log') : null)) : null,
      h('p.section-title', 'Source'),
      codeBlock(sourceCache.content, { highlightLine: sel.line, failLine: fl }),
    );
  }

  function renderConsole() {
    if (!consoleBody) return;
    if (state.runOutput.length) consoleWrap.hidden = false;
    set(consoleBody, ...state.runOutput.slice(-800).map((l) => h(`div${l.cls ? `.${l.cls}` : ''}`, l.text)));
    consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  const renderConsoleSoon = debounce(renderConsole, 50);

  return {
    mount,
    runSelected,
    unmount() { root = explorer = detail = consoleBody = consoleWrap = null; },
    onTests() { renderExplorer(); },
    async onRun(event) {
      renderExplorer();
      renderConsoleSoon();
      if (event?.type === 'status' && event.record.status !== 'running' && state.selected) {
        lastResult = await findLastResult(state.selected);
        renderDetail();
      }
    },
  };
})();

// ═════════════════════════════════════════════════════════════════════════
// Record view
// ═════════════════════════════════════════════════════════════════════════

views.record = (() => {
  let root, toolbar, stepsList, suggestionsBox, codeWrap, targetCard, saveForm;
  const form = {
    mode: 'launch', pid: null,
    testName: 'recorded flow', describeName: '', path: 'tests/recorded.spec.ts', saveMode: 'new',
  };
  let freshIds = new Set();
  let lastCode = '';

  function mount(main) {
    toolbar = h('div.view-head.rec-toolbar');
    targetCard = h('div.card.target-card');
    stepsList = h('ol.steps', {
      // Step lists do not re-render under someone typing; catch up once they leave.
      onfocusout: () => setTimeout(() => { if (!stepsList?.contains(document.activeElement)) renderSteps(); }, 0),
    });
    suggestionsBox = h('div.suggestions');
    codeWrap = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
    saveForm = h('div.save-form');
    root = h('section.view',
      toolbar,
      h('div.rec-grid',
        h('div.pane', targetCard, suggestionsBox, stepsList),
        h('div.pane.code-pane', codeWrap, saveForm)),
    );
    main.append(root);
    renderAll();
    loadApps();
  }

  async function loadApps() {
    try {
      state.apps = await api('GET', '/api/apps');
      renderTarget();
    } catch { /* platform without a driver; target card explains */ }
  }

  function renderAll() {
    renderToolbar();
    renderTarget();
    renderSuggestions();
    renderSteps();
    renderSaveForm();
    refreshCode();
  }

  function renderToolbar() {
    if (!toolbar) return;
    const r = state.recorder;
    const hasSteps = r.steps.length > 0;
    set(toolbar,
      h('h1', 'Recorder'),
      r.recording
        ? h('div.rec-status', h('span.pill.rec', r.picking ? 'Click an element to assert on' : 'Recording'), r.app ? h('span.app-name', `${r.app.name}`) : null, r.app ? h('span.pill', `pid ${r.app.pid}`) : null)
        : r.app ? h('div.rec-status', h('span.pill', 'Paused'), h('span.app-name', r.app.name)) : null,
      h('span.grow'),
      r.recording
        ? [
          h('button.btn', { onclick: pick, disabled: r.picking, title: 'Your next click selects an element to assert on, without clicking it in the app' }, svg(ICON.target, 's'), 'Assert on element'),
          h('button.btn', { onclick: (e) => addCheckMenu(e.currentTarget) }, svg(ICON.plus, 's'), 'Add step'),
          h('button.btn.btn-danger', { onclick: stop }, svg('<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>'), 'Stop'),
        ]
        : [
          hasSteps ? h('button.btn', { onclick: (e) => addCheckMenu(e.currentTarget) }, svg(ICON.plus, 's'), 'Add step') : null,
          hasSteps ? h('button.btn', { onclick: replay, disabled: !!state.run, title: 'Save to a scratch spec and run it now' }, svg(ICON.play), 'Replay') : null,
          hasSteps ? h('button.btn.btn-ghost', { onclick: clear }, 'Clear') : null,
          r.app?.launched ? h('button.btn.btn-ghost', { onclick: () => api('POST', '/api/recorder/close-app').catch(fail) }, 'Quit app') : null,
          h('button.btn.btn-rec', { onclick: () => start(hasSteps), disabled: !!state.run || !state.project?.platformSupported },
            svg('<circle cx="8" cy="8" r="5"/>'), hasSteps ? 'Resume recording' : 'Start recording'),
        ],
    );
  }

  function renderTarget() {
    if (!targetCard) return;
    const r = state.recorder;
    const p = state.project;
    if (r.recording) {
      set(targetCard,
        h('p.section-title', 'How to record'),
        h('div', { style: { color: 'var(--text-2)' } },
          'Use ', h('strong', r.app?.name ?? 'the app'), ' normally — clicks, typing, tray and menu bar. ',
          'Each action becomes a step below. Use ', h('strong', 'Assert on element'), ' to check something without clicking it. ',
          'Actions in other apps (including this browser) are ignored.'));
      return;
    }
    if (p && !p.platformSupported) {
      set(targetCard, h('div.callout.warn', `Recording needs a native driver, and ${p.platform} does not have one yet. See docs/WINDOWS.md.`));
      return;
    }
    const appOptions = state.apps.map((a) => h('option', { value: a.pid, selected: form.pid === a.pid }, `${a.name}${a.bundleId ? ` — ${a.bundleId}` : ''} (${a.pid})`));
    set(targetCard,
      h('p.section-title', 'App to record'),
      h('div.seg', { role: 'group' },
        h('button', { 'aria-pressed': form.mode === 'launch' ? 'true' : 'false', onclick: () => { form.mode = 'launch'; renderTarget(); } }, 'Launch configured app'),
        h('button', { 'aria-pressed': form.mode === 'attach' ? 'true' : 'false', onclick: () => { form.mode = 'attach'; renderTarget(); } }, 'Attach to running app')),
      form.mode === 'launch'
        ? h('div.row', h('span.mono', { style: { color: 'var(--text-2)', overflowWrap: 'anywhere' } }, p?.app ? rel(p.app) : 'No app configured for this platform in dtf.config — attach instead.'))
        : h('div.row',
          h('select.select', { style: { flex: '1' }, onchange: (e) => { form.pid = Number(e.target.value); } },
            h('option', { value: '' }, state.apps.length ? 'Choose a running app…' : 'Loading apps…'), appOptions),
          iconBtn('refresh', 'Refresh app list', loadApps)),
    );
  }

  function renderSuggestions() {
    if (!suggestionsBox) return;
    const list = state.recorder.suggestions ?? [];
    set(suggestionsBox, ...(list.length ? [h('p.section-title', { style: { margin: '4px 0 2px' } }, 'Noticed while recording')] : []),
      ...list.slice(-6).map((s) => h('div.suggestion',
        h('span.label', { title: s.label }, s.label),
        h('button.btn.btn-sm', { onclick: () => api('POST', `/api/recorder/suggestions/${s.id}/accept`).catch(fail) }, 'Add check'),
        iconBtn('x', 'Dismiss', () => api('POST', `/api/recorder/suggestions/${s.id}/dismiss`).catch(fail)))));
  }

  function describe(s) {
    switch (s.kind) {
      case 'trayOpen': return `Open tray${s.label ? ` “${s.label}”` : ''}${s.button === 'right' ? ' (right-click)' : ''}`;
      case 'trayMenu': return `Tray menu › ${s.path.join(' › ')}`;
      case 'menu': return `Menu bar › ${s.path.join(' › ')}`;
      case 'click': return `${s.count > 1 ? 'Double-click' : s.button === 'right' ? 'Right-click' : 'Click'} ${s.target.label}`;
      case 'fill': return `Type into ${s.target.label}`;
      case 'type': return 'Type text';
      case 'press': return `Press ${s.combo}`;
      case 'dialogButton': return `Dialog › ${s.button}`;
      case 'notificationClick': return s.action ? `Notification › ${s.action}` : 'Click notification';
      case 'wait': return `Wait ${s.ms}ms`;
      case 'comment': return 'Comment';
      case 'expect': {
        const c = s.check;
        const t = c.target?.label;
        return {
          visible: `Expect ${t} to be visible`, hidden: `Expect ${t} to be gone`, enabled: `Expect ${t} to be enabled`,
          disabled: `Expect ${t} to be disabled`, text: `Check the text of ${t}`,
          notification: 'Expect a notification', dialog: 'Expect a dialog', window: 'Expect a window',
          noWindows: 'Expect no open windows', trayItem: 'Expect the tray icon', menuItem: 'Expect a menu item',
          log: 'Expect a log line', running: 'Expect the app to be running',
        }[c.type] ?? 'Expect';
      }
    }
    return s.kind;
  }

  function scopeText(t) {
    const s = t.scope;
    return s.kind === 'window' ? `in window “${s.title}”` : s.kind === 'dialog' ? 'in dialog' : s.kind === 'trayPopup' ? 'in tray popup' : 'in app';
  }

  const patchStep = debounce((id, patch) => api('PATCH', `/api/recorder/steps/${id}`, { patch }).catch(fail), 350);

  function selectorEditor(step, target, apply) {
    const opts = [target.selector, ...(target.alternatives ?? [])];
    const input = h('input.input.mono', {
      value: target.selector, spellcheck: 'false', 'aria-label': 'Selector',
      oninput: (e) => apply({ ...target, selector: e.target.value }),
    });
    const alt = opts.length > 1 ? h('select.select', {
      style: { maxWidth: '44%' }, 'aria-label': 'Other selectors',
      onchange: (e) => { if (e.target.value) { input.value = e.target.value; apply({ ...target, selector: e.target.value }); } },
    }, h('option', { value: '' }, `${opts.length - 1} alternative${opts.length > 2 ? 's' : ''}`), opts.slice(1).map((o) => h('option', { value: o }, o))) : null;
    return h('div.row', input, alt);
  }

  function stepMeta(s) {
    const rows = [];
    const t = s.target ?? s.check?.target;
    if (t) {
      rows.push(h('div.scope', scopeText(t), t.verified === false ? h('span.unverified', ' · not verified against the live UI') : null));
      rows.push(selectorEditor(s, t, (nt) => {
        if (s.target) { s.target = nt; patchStep(s.id, { target: nt }); } else { s.check = { ...s.check, target: nt }; patchStep(s.id, { check: s.check }); }
      }));
    }
    const textField = (value, onChange, placeholder) => h('input.input', { value, placeholder, oninput: (e) => onChange(e.target.value) });
    if (s.kind === 'fill' || s.kind === 'type') rows.push(textField(s.text, (v) => { s.text = v; patchStep(s.id, { text: v }); }, 'Text'));
    if (s.kind === 'press') rows.push(textField(s.combo, (v) => { s.combo = v; patchStep(s.id, { combo: v }); }, 'e.g. mod+s'));
    if (s.kind === 'wait') rows.push(textField(String(s.ms), (v) => { s.ms = Number(v) || 0; patchStep(s.id, { ms: s.ms }); }, 'milliseconds'));
    if (s.kind === 'comment') rows.push(textField(s.text, (v) => { s.text = v; patchStep(s.id, { text: v }); }, 'Comment'));
    if (s.kind === 'trayMenu' || s.kind === 'menu') {
      rows.push(textField(s.path.join(' › '), (v) => { s.path = v.split('›').map((x) => x.trim()).filter(Boolean); patchStep(s.id, { path: s.path }); }, 'Item › Subitem'));
    }
    if (s.kind === 'dialogButton') rows.push(textField(s.button, (v) => { s.button = v; patchStep(s.id, { button: v }); }, 'Button title'));
    if (s.kind === 'expect') {
      const c = s.check;
      const upd = (patch) => { s.check = { ...c, ...patch }; patchStep(s.id, { check: s.check }); };
      if (c.type === 'text') rows.push(textField(c.text, (v) => upd({ text: v }), 'Expected text (substring)'));
      if (c.type === 'notification') rows.push(h('div.row', textField(c.title ?? '', (v) => upd({ title: v || undefined }), 'Title contains'), textField(c.body ?? '', (v) => upd({ body: v || undefined }), 'Body contains')));
      if (c.type === 'dialog') rows.push(h('div.row', textField(c.title ?? '', (v) => upd({ title: v || undefined }), 'Title contains'), textField(c.text ?? '', (v) => upd({ text: v || undefined }), 'Text contains')));
      if (c.type === 'window') rows.push(textField(c.title, (v) => upd({ title: v }), 'Window title contains'));
      if (c.type === 'trayItem') rows.push(textField(c.label ?? '', (v) => upd({ label: v || undefined }), 'Label (optional)'));
      if (c.type === 'menuItem') rows.push(textField(c.path.join(' › '), (v) => upd({ path: v.split('›').map((x) => x.trim()).filter(Boolean) }), 'File › Save'));
      if (c.type === 'log') rows.push(textField(c.pattern, (v) => upd({ pattern: v }), 'Regular expression'));
    }
    return rows.length ? h('div.meta', rows) : null;
  }

  function renderSteps() {
    if (!stepsList) return;
    const steps = state.recorder.steps;
    if (!steps.length) {
      set(stepsList, h('li.empty', { style: { height: 'auto', padding: '40px 16px' } },
        h('h2', state.recorder.recording ? 'Waiting for your first action' : 'Nothing recorded yet'),
        h('p', state.recorder.recording
          ? 'Click, type, open the tray or a menu in the app. Steps appear here as you go.'
          : 'Choose the app above and start recording. You can edit selectors, add checks and reorder steps afterwards.')));
      return;
    }
    const focusedId = document.activeElement?.closest?.('.step')?.dataset.id;
    if (focusedId) return; // never yank the input someone is typing in
    set(stepsList, ...steps.map((s, i) => h(`li.step.kind-${s.kind}${freshIds.has(s.id) ? '.fresh' : ''}`, { 'data-id': s.id },
      h('span.num'),
      h('div', h('div.desc', describe(s)), stepMeta(s)),
      h('div.tools',
        i > 0 ? iconBtn('up', 'Move up', () => api('POST', `/api/recorder/steps/${s.id}/move`, { to: i - 1 }).catch(fail)) : null,
        i < steps.length - 1 ? iconBtn('down', 'Move down', () => api('POST', `/api/recorder/steps/${s.id}/move`, { to: i + 1 }).catch(fail)) : null,
        iconBtn('trash', 'Delete step', () => api('DELETE', `/api/recorder/steps/${s.id}`).catch(fail))),
    )));
    freshIds = new Set();
    stepsList.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  const refreshCode = debounce(async () => {
    if (!codeWrap) return;
    try {
      const { code } = await api('POST', '/api/recorder/code', { testName: form.testName, describeName: form.describeName, path: form.path });
      if (code === lastCode && codeWrap.firstChild) return;
      lastCode = code;
      set(codeWrap, codeBlock(code));
    } catch (err) {
      set(codeWrap, h('div.pane-pad', h('div.callout.fail', err.message)));
    }
  }, 120);

  function renderSaveForm() {
    if (!saveForm) return;
    const field = (label, key, attrs = {}) => h('label.field', attrs.full ? { class: 'field full' } : {},
      h('span', label),
      h('input.input', { value: form[key], placeholder: attrs.placeholder, oninput: (e) => { form[key] = e.target.value; refreshCode(); } }));
    set(saveForm,
      field('Test name', 'testName', { placeholder: 'what this test proves' }),
      field('Describe block (optional)', 'describeName', { placeholder: 'e.g. Tray' }),
      field('File', 'path', { full: true, placeholder: 'tests/recorded.spec.ts' }),
      h('div.actions',
        h('button.btn.btn-ghost', { onclick: () => copy(lastCode), disabled: !state.recorder.steps.length }, svg(ICON.copy, 's'), 'Copy'),
        h('button.btn', { onclick: () => save('append'), disabled: !state.recorder.steps.length, title: 'Add this test to the end of an existing file' }, 'Append to file'),
        h('button.btn.btn-primary', { onclick: () => save('new'), disabled: !state.recorder.steps.length }, 'Save as new file')),
    );
  }

  async function save(mode, overwrite = false) {
    try {
      const r = await api('POST', '/api/recorder/save', { path: form.path, testName: form.testName, describeName: form.describeName, mode, overwrite });
      toast(`${r.appended ? 'Appended to' : 'Saved'} ${r.path}`, 'ok');
      refreshLatest();
    } catch (err) {
      if (/already exists/.test(err.message)) {
        openModal((close) => [
          h('div.modal-head', h('h2', 'File already exists'), h('p', `${form.path} is already there.`)),
          h('div.modal-foot',
            h('button.btn.btn-ghost', { onclick: close }, 'Cancel'),
            h('button.btn', { onclick: () => { close(); save('append'); } }, 'Append test'),
            h('button.btn.btn-danger', { onclick: () => { close(); save('new', true); } }, 'Overwrite')),
        ]);
      } else fail(err);
    }
  }

  async function start(keepSteps) {
    try {
      const body = form.mode === 'attach' ? { mode: 'attach', pid: form.pid, keepSteps } : { mode: 'launch', keepSteps };
      if (form.mode === 'attach' && !form.pid) throw new Error('Choose a running app to attach to');
      toolbar.querySelector('.btn-rec')?.replaceChildren(h('span.spinner'), form.mode === 'launch' ? 'Launching…' : 'Attaching…');
      Object.assign(state.recorder, await api('POST', '/api/recorder/start', body));
    } catch (err) { fail(err); }
    renderAll();
  }
  async function stop() {
    try { Object.assign(state.recorder, await api('POST', '/api/recorder/stop')); } catch (err) { fail(err); }
    renderAll();
  }
  async function clear() {
    try { Object.assign(state.recorder, await api('POST', '/api/recorder/clear')); } catch (err) { fail(err); }
    renderAll();
  }
  async function replay() {
    try {
      state.runOutput = [];
      await api('POST', '/api/recorder/replay');
      toast('Replaying — watch the app. Results appear in the Tests and Runs tabs.');
    } catch (err) { fail(err); }
  }
  async function pick() {
    try { await api('POST', '/api/recorder/pick'); } catch (err) { fail(err); }
  }
  const addStep = (step) => api('POST', '/api/recorder/steps', { step }).catch(fail);

  function addCheckMenu(anchor) {
    document.querySelector('.menu-pop')?.remove();
    const rect = anchor.getBoundingClientRect();
    const item = (label, hint, step) => h('button', { onclick: () => { menu.remove(); addStep(typeof step === 'function' ? step() : step); } }, label, hint ? h('span.hint', hint) : null);
    const menu = h('div.menu-pop', { style: { top: `${rect.bottom + 4}px`, left: `${Math.max(8, rect.right - 260)}px` } },
      item('Notification appeared', 'shouldHave', { kind: 'expect', check: { type: 'notification', title: '' } }),
      item('Dialog appeared', 'shouldAppear', { kind: 'expect', check: { type: 'dialog', title: '' } }),
      item('Window is open', 'shouldExist', { kind: 'expect', check: { type: 'window', title: '' } }),
      item('No windows open', 'shouldHaveNone', { kind: 'expect', check: { type: 'noWindows' } }),
      item('Tray icon exists', 'shouldExist', { kind: 'expect', check: { type: 'trayItem' } }),
      item('Menu item exists', 'menu.shouldHave', { kind: 'expect', check: { type: 'menuItem', path: [] } }),
      item('App logged a line', 'waitForLog', { kind: 'expect', check: { type: 'log', pattern: '' } }),
      item('App still running', 'isRunning', { kind: 'expect', check: { type: 'running' } }),
      item('Wait', '', { kind: 'wait', ms: 500 }),
      item('Press a key', '', { kind: 'press', combo: 'enter' }),
      item('Comment', '', { kind: 'comment', text: '' }),
    );
    document.body.append(menu);
    setTimeout(() => document.addEventListener('click', function off(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off); }
    }), 0);
  }

  function showPick(p) {
    const t = p.target;
    const text = p.text ?? '';
    openModal((close) => {
      const choose = (check) => { close(); addStep({ kind: 'expect', check }); };
      return [
        h('div.modal-head', h('h2', `Assert on ${t.label}`), h('p', scopeText(t))),
        h('div.modal-body',
          h('div.selector-item', h('code', t.selector), t.verified === false ? h('span.unverified', 'unverified') : h('span.pill.pass', 'unique')),
          h('div.choice-grid',
            h('button.choice', { onclick: () => choose({ type: 'visible', target: t }) }, h('strong', 'Is visible'), h('span', 'shouldExist()')),
            text ? h('button.choice', { onclick: () => choose({ type: 'text', target: t, text }) }, h('strong', 'Has its current text'), h('span', `“${text.slice(0, 60)}”`)) : null,
            p.enabled === false
              ? h('button.choice', { onclick: () => choose({ type: 'disabled', target: t }) }, h('strong', 'Is disabled'), h('span', 'shouldBeDisabled()'))
              : h('button.choice', { onclick: () => choose({ type: 'enabled', target: t }) }, h('strong', 'Is enabled'), h('span', 'shouldBeEnabled()')),
            h('button.choice', { onclick: () => choose({ type: 'hidden', target: t }) }, h('strong', 'Is gone'), h('span', 'shouldNotExist() — e.g. after closing'))),
        ),
        h('div.modal-foot', h('button.btn.btn-ghost', { onclick: close }, 'Cancel')),
      ];
    });
  }

  return {
    mount,
    showPick,
    unmount() { root = toolbar = stepsList = suggestionsBox = codeWrap = targetCard = saveForm = null; document.querySelector('.menu-pop')?.remove(); },
    onRecorder(e) {
      if (e?.type === 'recorder:steps') {
        const known = new Set([...(stepsList?.querySelectorAll('.step') ?? [])].map((x) => x.dataset.id));
        for (const s of state.recorder.steps) if (!known.has(s.id)) freshIds.add(s.id);
        renderSteps();
        renderToolbar();
        renderSaveForm();
        refreshCode();
        return;
      }
      if (e?.type === 'recorder:suggestion') { renderSuggestions(); return; }
      renderAll();
    },
    onRun() { renderToolbar(); },
  };
})();

// ═════════════════════════════════════════════════════════════════════════
// Inspect view
// ═════════════════════════════════════════════════════════════════════════

views.inspect = (() => {
  let root, head, treeBox, side;
  let pid = null;
  let tree = null;
  let selected = null;
  let expanded = new Set();
  let query = '';
  let matches = new Set();
  let pickInfo = null;

  function mount(main) {
    head = h('div.view-head');
    treeBox = h('div.pane');
    side = h('div.pane.pane-pad');
    root = h('section.view', head, h('div.split', treeBox, side));
    main.append(root);
    renderHead();
    renderTree();
    renderSide();
    if (!state.apps.length) api('GET', '/api/apps').then((a) => { state.apps = a; renderHead(); }).catch(() => {});
  }

  function renderHead() {
    if (!head) return;
    const recApp = state.recorder.app;
    set(head,
      h('h1', 'Inspector'),
      h('select.select', { style: { minWidth: '260px' }, onchange: (e) => { pid = Number(e.target.value) || null; load(); } },
        h('option', { value: '' }, 'Choose an app…'),
        recApp ? h('option', { value: recApp.pid, selected: pid === recApp.pid }, `${recApp.name} (recording target)`) : null,
        state.apps.filter((a) => a.pid !== recApp?.pid).map((a) => h('option', { value: a.pid, selected: pid === a.pid }, `${a.name} (${a.pid})`))),
      iconBtn('refresh', 'Reload tree', () => (pid ? load() : api('GET', '/api/apps').then((a) => { state.apps = a; renderHead(); }))),
      h('span.grow'),
      h('input.input.mono', {
        style: { width: '320px' }, placeholder: 'Test a selector, e.g. button[title="Save"]', value: query, spellcheck: 'false',
        onkeydown: (e) => { if (e.key === 'Enter') runQuery(e.target.value); },
      }),
      h('button.btn', { onclick: pickFromScreen, disabled: !state.project?.platformSupported, title: 'Your next click selects an element to inspect' }, svg(ICON.target, 's'), 'Pick from screen'),
    );
  }

  async function load() {
    if (!pid) { tree = null; renderTree(); return; }
    set(treeBox, h('div.empty', h('span.spinner'), 'Reading accessibility tree…'));
    try {
      tree = await api('GET', `/api/inspect/tree?pid=${pid}&depth=12`);
      expanded = new Set([tree.ref]);
      // Open the path to the first window so there is something to look at.
      const firstWin = tree.children?.find((c) => c.role.endsWith('Window'));
      if (firstWin) expanded.add(firstWin.ref);
    } catch (err) {
      tree = null;
      set(treeBox, h('div.pane-pad', h('div.callout.fail', err.message)));
      return;
    }
    renderTree();
  }

  function labelOf(n) {
    return n.title || n.description || (typeof n.value === 'string' ? n.value : '') || n.placeholder || '';
  }

  function renderTree() {
    if (!treeBox) return;
    if (!tree) {
      set(treeBox, h('div.empty', h('h2', 'Pick an app'), h('p', 'Browse its accessibility tree to find stable selectors, or use Pick from screen and click any element.')));
      return;
    }
    const rows = [];
    const walk = (n, depth) => {
      const kids = n.children ?? [];
      const open = expanded.has(n.ref);
      rows.push(h(`div.tree-node${matches.has(n.ref) ? '.match' : ''}`, {
        style: { paddingLeft: `${8 + depth * 14}px` },
        'aria-selected': selected?.ref === n.ref ? 'true' : 'false',
        onclick: () => { selected = n; pickInfo = null; renderTree(); renderSide(); },
      },
      h('span.tw', {
        onclick: (e) => { e.stopPropagation(); open ? expanded.delete(n.ref) : expanded.add(n.ref); renderTree(); },
      }, kids.length ? (open ? '▾' : '▸') : ''),
      h('span.role', n.role.replace(/^AX/, '')),
      n.identifier ? h('span.ident', `#${n.identifier}`) : null,
      labelOf(n) ? h('span.label', `“${String(labelOf(n)).slice(0, 80)}”`) : null));
      if (open) for (const k of kids) walk(k, depth + 1);
    };
    walk(tree, 0);
    set(treeBox, h('div.tree', rows));
  }

  function candidatesFor(n) {
    // Mirrors the recorder's preference order closely enough for browsing;
    // the authoritative version runs server-side on picks.
    const role = { AXButton: 'button', AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXStaticText: 'text', AXTextField: 'textfield', AXTextArea: 'textarea', AXWindow: 'window', AXMenuItem: 'menuitem', AXMenuBarItem: 'menubaritem', AXGroup: 'group', AXImage: 'image', AXLink: 'link', AXPopUpButton: 'popup', AXSlider: 'slider', AXScrollArea: 'scrollarea', AXToolbar: 'toolbar', AXTable: 'table', AXRow: 'row', AXCell: 'cell', AXList: 'list', AXMenu: 'menu', AXMenuBar: 'menubar', AXSheet: 'sheet', AXWebArea: 'webarea' }[n.role] ?? n.role;
    const q = (v) => (v.includes('"') ? `'${v}'` : `"${v}"`);
    const out = [];
    // Same rule as the recorder: per-launch ids (AppKit's _NS:123, bare numbers, UUIDs) make selectors that pass once.
    const stableId = n.identifier && !/^_NS:\d+$|^\d+$|[0-9a-f]{8}-[0-9a-f]{4}-|\s/i.test(n.identifier);
    if (stableId) out.push(`#${n.identifier}`);
    if (n.title) out.push(`${role}[title=${q(n.title)}]`);
    if (n.description) out.push(`${role}[desc=${q(n.description)}]`);
    if (n.placeholder) out.push(`${role}[text=${q(n.placeholder)}]`);
    if (n.role === 'AXStaticText' && typeof n.value === 'string' && n.value.length < 80) out.push(`text[value=${q(n.value)}]`);
    out.push(role);
    return out;
  }

  function renderSide() {
    if (!side) return;
    if (pickInfo) {
      const c = pickInfo.context;
      const el = c.element ?? {};
      set(side,
        h('p.section-title', 'Picked element'),
        h('table.attr-table', h('tbody',
          [['app', `${c.app} (${c.pid})`], ['surface', c.surface], ['role', el.role], ['title', el.title], ['description', el.description], ['identifier', el.identifier], ['value', el.value],
            ['window', c.window?.title], ['menu path', c.menuPath?.join(' › ')]]
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => h('tr', h('td', k), h('td', String(v)))))),
        h('p.section-title', { style: { marginTop: '18px' } }, 'Selectors'),
        h('div.selector-list', (pickInfo.candidates ?? []).map((s) => h('div.selector-item', h('code', s), iconBtn('copy', 'Copy', () => copy(s))))),
        c.ancestors?.length ? [h('p.section-title', { style: { marginTop: '18px' } }, 'Ancestors'),
          h('div.mono', { style: { color: 'var(--text-2)', lineHeight: '1.8' } }, c.ancestors.slice(0, 12).map((a) => h('div', `${a.role.replace(/^AX/, '')}${a.identifier ? ` #${a.identifier}` : ''}${a.title ? ` “${a.title}”` : ''}`)))] : null,
      );
      return;
    }
    if (!selected) {
      set(side, h('div.empty', h('h2', 'No element selected'), h('p', 'Select a node in the tree to see its attributes and selectors.')));
      return;
    }
    const n = selected;
    set(side,
      h('p.section-title', 'Attributes'),
      h('table.attr-table', h('tbody',
        Object.entries(n).filter(([k]) => !['children', 'ref'].includes(k))
          .map(([k, v]) => h('tr', h('td', k), h('td', typeof v === 'object' ? JSON.stringify(v) : String(v)))))),
      h('p.section-title', { style: { marginTop: '18px' } }, 'Selectors'),
      h('div.selector-list', candidatesFor(n).map((s) => h('div.selector-item',
        h('code', s),
        h('button.btn.btn-sm', { onclick: () => runQuery(s) }, 'Test'),
        iconBtn('copy', 'Copy', () => copy(s))))),
    );
  }

  async function runQuery(sel) {
    query = sel;
    if (!pid) return toast('Choose an app first', 'error');
    try {
      const r = await api('POST', '/api/inspect/query', { pid, selector: sel });
      matches = new Set();
      // Match by rect + role, since refs from a query differ from the tree's.
      const key = (n) => `${n.role}|${JSON.stringify(n.rect)}|${n.title ?? ''}|${n.identifier ?? ''}`;
      const wanted = new Set(r.nodes.map(key));
      const walk = (n) => { if (wanted.has(key(n))) { matches.add(n.ref); } (n.children ?? []).forEach(walk); };
      if (tree) walk(tree);
      toast(`${r.count} match${r.count === 1 ? '' : 'es'} for ${sel}`, r.count === 1 ? 'ok' : r.count ? 'info' : 'error');
      renderHead();
      renderTree();
    } catch (err) { fail(err); }
  }

  async function pickFromScreen() {
    try {
      await api('POST', '/api/inspect/pick');
      toast('Click any element on screen to inspect it.');
    } catch (err) { fail(err); }
  }

  return {
    mount,
    unmount() { root = head = treeBox = side = null; },
    showPick(p) {
      pickInfo = p.context ? { context: p.context, candidates: p.candidates ?? [p.target?.selector, ...(p.target?.alternatives ?? [])].filter(Boolean) } : null;
      if (pickInfo && pickInfo.context.pid !== pid) {
        pid = pickInfo.context.pid;
        renderHead();
        load();
      }
      renderSide();
    },
    onRecorder() { renderHead(); },
  };
})();

// ═════════════════════════════════════════════════════════════════════════
// Runs view
// ═════════════════════════════════════════════════════════════════════════

views.runs = (() => {
  let root, list, detail;
  let runs = [];
  let selectedId = null;

  function mount(main) {
    list = h('div.pane');
    detail = h('div.pane.pane-pad');
    root = h('section.view', h('div.split', { style: { gridTemplateColumns: 'minmax(360px, 460px) 1fr' } }, list, detail));
    main.append(root);
    load();
  }

  async function load() {
    try { runs = await api('GET', '/api/runs'); } catch (err) { fail(err); }
    renderList();
    if (!selectedId && runs[0]) show(runs[0].id);
    else if (selectedId) show(selectedId);
  }

  const statusPill = (r) => h(`span.pill.${{ passed: 'pass', failed: 'fail', errored: 'fail', running: 'accent', cancelled: 'warn' }[r.status] ?? ''}`, r.status);

  function renderList() {
    if (!list) return;
    if (!runs.length) {
      set(list, h('div.empty', h('h2', 'No runs yet'), h('p', 'Runs started from the Studio are kept here with their results and artifacts.')));
      return;
    }
    set(list, h('table.table',
      h('thead', h('tr', h('th', 'Run'), h('th', 'Result'), h('th', 'When'))),
      h('tbody', runs.map((r) => h('tr', { 'aria-selected': r.id === selectedId ? 'true' : 'false', onclick: () => show(r.id) },
        h('td', h('div', { style: { fontWeight: '500' } }, r.label), r.platform ? h('div', { style: { color: 'var(--text-3)', fontSize: '11.5px' } }, r.platform) : null),
        h('td', statusPill(r), r.summary ? h('div.num-cell', { style: { fontSize: '11.5px', marginTop: '3px' } }, `${r.summary.passed}/${r.summary.total} · ${ms(r.summary.durationMs)}`) : null),
        h('td.num-cell', ago(r.startedAt)))))));
  }

  async function show(id) {
    selectedId = id;
    renderList();
    let r;
    try { r = await api('GET', `/api/runs/${id}`); } catch (err) { return fail(err); }
    if (!detail) return;
    const s = r.summary;
    set(detail,
      h('div.detail-head',
        h('div', { style: { flex: '1' } }, h('h2', r.label), h('div.path', new Date(r.startedAt).toLocaleString())),
        statusPill(r),
        h('button.btn', { onclick: () => startRun({ ...r.request, label: r.label }), disabled: !!state.run }, svg(ICON.play), 'Run again')),
      s ? h('div.summary-bar', { style: { marginBottom: '12px' } },
        h('span.pill.pass', `${s.passed} passed`), s.failed ? h('span.pill.fail', `${s.failed} failed`) : null,
        s.skipped ? h('span.pill', `${s.skipped} skipped`) : null, h('span.pill', ms(s.durationMs))) : null,
      r.results.map((t) => h('div.result-row',
        h(`span.dot.${t.status}`),
        h('div.body',
          h('div.title', t.name),
          h('div.sub', `${rel(t.file)}${t.line ? `:${t.line}` : ''} · ${ms(t.durationMs)}${t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}`),
          t.error ? h('div.error-box', { style: { marginTop: '8px', marginBottom: '0' } }, h('pre.msg', t.error.message)) : null,
          t.screenshot ? h('a.shot', { href: artifactUrl(t.screenshot), target: '_blank', style: { display: 'block', marginTop: '8px' } },
            h('img', { src: artifactUrl(t.screenshot), alt: 'Screenshot at failure', loading: 'lazy', style: { maxWidth: '100%', maxHeight: '260px', borderRadius: '6px', border: '1px solid var(--line)' } })) : null,
          (t.treeDump || t.appLog) ? h('div.artifact-links', { style: { marginTop: '8px' } },
            t.treeDump ? h('a.btn.btn-sm', { href: artifactUrl(t.treeDump), target: '_blank' }, 'Accessibility tree') : null,
            t.appLog ? h('a.btn.btn-sm', { href: artifactUrl(t.appLog), target: '_blank' }, 'App log') : null) : null),
      )),
      r.output?.length ? [h('p.section-title', { style: { marginTop: '18px' } }, 'Output'), h('pre.code', { style: { padding: '10px 12px', whiteSpace: 'pre-wrap' } }, r.output.join('\n'))] : null,
    );
  }

  return {
    mount,
    unmount() { root = list = detail = null; },
    onRun(event) { if (event?.type === 'status' || event?.type === 'test-done') load(); },
  };
})();

// ═════════════════════════════════════════════════════════════════════════
// Doctor view
// ═════════════════════════════════════════════════════════════════════════

views.doctor = (() => {
  let body;
  function mount(main) {
    body = h('div.pane-pad');
    main.append(h('section.view',
      h('div.view-head', h('h1', 'Doctor'), h('span', { style: { color: 'var(--text-2)' } }, 'Environment checks — most failing desktop suites are an environment problem, not a code one.'),
        h('span.grow'), h('button.btn', { onclick: load }, svg(ICON.refresh, 's'), 'Re-check')),
      h('div.pane', body)));
    load();
  }
  async function load() {
    set(body, h('div.empty', h('span.spinner'), 'Checking…'));
    try {
      const checks = await api('GET', '/api/doctor');
      set(body, h('ul.checks', checks.map((c) => h(`li.check.${c.ok === true ? 'ok' : c.ok === 'warn' ? 'warn' : 'bad'}`,
        h('span.icon', c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'),
        h('span.name', c.name),
        h('span.detail', c.detail)))));
    } catch (err) {
      set(body, h('div.callout.fail', err.message));
    }
  }
  return { mount, unmount() { body = null; } };
})();

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const s = await api('GET', '/api/state');
    state.project = s.project;
    state.run = s.run;
    Object.assign(state.recorder, s.recorder);
    document.title = `${s.project.name} · dtf Studio`;
  } catch (err) {
    fail(err);
  }
  renderProject();
  renderRunIndicator();
  markRecording();
  connect();
  const route = () => setView((location.hash || '#tests').slice(1));
  window.addEventListener('hashchange', route);
  route();
}

boot();

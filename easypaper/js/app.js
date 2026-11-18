// EasyPaper: shows a PDF with PDF.js, finds its paragraphs, translates them
// with the chosen LLM API and shows a paragraph's translation on hover.

// Keep this version in sync with the integrity entry in index.html.
import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.min.mjs';
import { pageLines, buildParagraphs } from './segment.js';
import { PROVIDERS, listModels } from './llm.js';
import { Translator } from './translate.js';
import * as store from './store.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/';
pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}build/pdf.worker.min.mjs`;

const MAX_CANVAS_PIXELS = 8e6;

const $ = id => document.getElementById(id);
const ui = {
  viewer: $('viewer'),
  pages: $('pages'),
  empty: $('empty'),
  fileInput: $('file-input'),
  docName: $('doc-name'),
  pageInfo: $('page-info'),
  zoomFit: $('zoom-fit'),
  status: $('status'),
  translate: $('translate'),
  progressBar: $('progress-bar'),
  keyState: $('key-state'),
  tip: $('tip'),
  tipMeta: $('tip-meta'),
  tipBody: $('tip-body'),
  tipRedo: $('tip-redo'),
  toast: $('toast'),
  dropOverlay: $('drop-overlay'),
  dialog: $('settings'),
  form: $('settings-form'),
};

let settings = store.loadSettings();
let doc = null;
let translator = null;
let zoom = 1;
let fitWidth = true;
let loadCount = 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v, total) => `${(v / total) * 100}%`;
const isCompatible = id => PROVIDERS[id].group === 'compatible';

/** A key, a model and, for OpenAI-compatible APIs, an address are all filled in. */
function isReady() {
  const id = settings.provider;
  return Boolean(settings.keys[id]?.trim() && settings.models[id]?.trim() && (!isCompatible(id) || settings.baseUrls[id]?.trim()));
}

// ---------------------------------------------------------------- document

async function openFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('PDF 파일만 열 수 있습니다.', { error: true });
    return;
  }
  closeDocument();
  const load = ++loadCount;
  ui.empty.hidden = true;
  ui.docName.textContent = file.name;
  document.title = `${file.name} · EasyPaper`;
  setStatus('PDF 여는 중…');

  let pdf;
  try {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: `${PDFJS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS}standard_fonts/`,
      wasmUrl: `${PDFJS}wasm/`,
      iccUrl: `${PDFJS}iccs/`,
    }).promise;
  } catch (err) {
    if (load !== loadCount) return;
    closeDocument();
    toast(err instanceof pdfjs.PasswordException ? '암호가 걸린 PDF는 열 수 없습니다.' : `PDF를 열 수 없습니다: ${err.message}`, { error: true });
    return;
  }
  if (load !== loadCount) {
    pdf.loadingTask.destroy();
    return;
  }

  const current = doc = {
    pdf,
    pages: [],
    title: '',
    paragraphs: [],
    byId: new Map(),
    boxes: new Map(), // paragraph id -> overlay elements (one per column or page it spans)
    keys: new Map(), // paragraph id -> cache key
    translations: new Map(),
    partial: new Map(), // translations still streaming in
    glossary: null, // [{term, translation, note}] once built
    glossaryKey: '',
    glossaryBusy: false,
  };
  for (let i = 1; i <= pdf.numPages; i++) {
    const proxy = await pdf.getPage(i);
    if (doc !== current) return;
    current.pages.push(createPage(proxy, i - 1));
  }
  fitWidth = true;
  applyZoom(fitZoom());
  observePages();
  ui.pageInfo.textContent = `1 / ${current.pages.length}`;

  const texts = [];
  for (const page of current.pages) {
    setStatus(`문단 찾는 중 ${page.index + 1}/${current.pages.length}`);
    const content = await page.proxy.getTextContent();
    if (doc !== current) return;
    texts.push({ lines: pageLines(content), view: page.proxy.view });
  }
  const { title, paragraphs } = buildParagraphs(texts);
  current.title = title;
  current.paragraphs = paragraphs;
  for (const p of paragraphs) current.byId.set(p.id, p);
  drawBoxes();
  await loadCachedTranslations();
  if (doc !== current) return;
  updateProgress();
  if (!paragraphs.length) {
    toast('번역할 문단을 찾지 못했습니다. 스캔한 이미지로 된 PDF는 글자 정보가 없어 번역할 수 없습니다.', { error: true });
  }
}

function createPage(proxy, index) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.index = index;
  const canvas = document.createElement('canvas');
  const layer = document.createElement('div');
  layer.className = 'layer';
  el.append(canvas, layer);
  ui.pages.append(el);
  return { proxy, index, viewport: proxy.getViewport({ scale: 1 }), el, canvas, layer, scale: 0, task: null };
}

function closeDocument() {
  stopTranslation();
  hideTip();
  observer?.disconnect();
  observer = null;
  visible.clear();
  doc?.pdf.loadingTask.destroy(); // frees the worker's copy of the document
  doc = null;
  ui.pages.replaceChildren();
  ui.pageInfo.textContent = '';
  ui.docName.textContent = '';
  ui.empty.hidden = false;
  document.title = 'EasyPaper';
  updateProgress();
  renderGlossary();
}

// ---------------------------------------------------------------- rendering

const visible = new Set();
let observer = null;

function observePages() {
  // Pages within a screen's height of the view get drawn; the rest give their canvas memory back.
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const page = doc?.pages[entry.target.dataset.index];
      if (!page) continue;
      if (entry.isIntersecting) {
        visible.add(page);
        renderPage(page);
      } else {
        visible.delete(page);
        releasePage(page);
      }
    }
  }, { root: ui.viewer, rootMargin: '100% 0px' });
  for (const page of doc.pages) observer.observe(page.el);
}

async function renderPage(page) {
  const { width, height } = page.viewport;
  const scale = Math.min(zoom * Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  if (page.scale === scale) return;
  page.task?.cancel();
  page.scale = scale;
  const viewport = page.proxy.getViewport({ scale });
  // Draw into a fresh canvas and swap it in, so zooming doesn't flash a blank page.
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.proxy.render({ canvas, viewport });
  page.task = task;
  try {
    await task.promise;
    page.canvas.replaceWith(canvas);
    page.canvas = canvas;
  } catch (err) {
    if (!(err instanceof pdfjs.RenderingCancelledException)) console.error(err);
    if (page.task === task) page.scale = 0;
  } finally {
    if (page.task === task) page.task = null;
  }
}

function releasePage(page) {
  page.task?.cancel();
  page.task = null;
  page.scale = 0;
  page.canvas.width = page.canvas.height = 0;
}

function fitZoom() {
  const widest = Math.max(...doc.pages.map(p => p.viewport.width));
  return clamp((ui.viewer.clientWidth - 48) / widest, 0.5, 2.5);
}

function applyZoom(value) {
  if (!doc) return;
  const anchor = ui.viewer.scrollTop / Math.max(ui.viewer.scrollHeight, 1);
  zoom = clamp(value, 0.4, 4);
  for (const page of doc.pages) {
    page.el.style.width = `${page.viewport.width * zoom}px`;
    page.el.style.height = `${page.viewport.height * zoom}px`;
  }
  ui.viewer.scrollTop = anchor * ui.viewer.scrollHeight;
  ui.zoomFit.textContent = `${Math.round(zoom * 100)}%`;
  for (const page of visible) renderPage(page);
  if (!ui.tip.hidden) placeTip();
}

function currentPage() {
  const middle = ui.viewer.scrollTop + ui.viewer.clientHeight / 2;
  let index = 0;
  for (const page of doc.pages) {
    if (page.el.offsetTop > middle) break;
    index = page.index;
  }
  return index;
}

// ---------------------------------------------------------------- paragraphs

function drawBoxes() {
  for (const para of doc.paragraphs) {
    const boxes = para.rects.map(rect => {
      const page = doc.pages[rect.page];
      const { width, height } = page.viewport;
      const [ax, ay] = page.viewport.convertToViewportPoint(rect.x0, rect.y0);
      const [bx, by] = page.viewport.convertToViewportPoint(rect.x1, rect.y1);
      const pad = 2;
      const box = document.createElement('div');
      box.className = 'para';
      box.dataset.id = para.id;
      box.tabIndex = 0;
      box.style.left = pct(Math.min(ax, bx) - pad, width);
      box.style.top = pct(Math.min(ay, by) - pad, height);
      box.style.width = pct(Math.abs(bx - ax) + 2 * pad, width);
      box.style.height = pct(Math.abs(by - ay) + 2 * pad, height);
      page.layer.append(box);
      return box;
    });
    doc.boxes.set(para.id, boxes);
  }
}

function paint(id) {
  const state = translator?.working.has(id) ? 'working'
    : translator?.pending.has(id) ? 'queued'
    : doc.translations.has(id) ? 'done'
    : '';
  for (const box of doc.boxes.get(id) || []) box.dataset.state = state;
}

function paintAll() {
  for (const para of doc?.paragraphs || []) paint(para.id);
}

function highlight(id, on) {
  for (const box of doc?.boxes.get(id) || []) box.classList.toggle('active', on);
}

// ---------------------------------------------------------------- translation

async function loadCachedTranslations() {
  const current = doc;
  const language = settings.language;
  const keys = await Promise.all(current.paragraphs.map(p => store.cacheKey(language, p.text)));
  // The glossary belongs to the whole paper, so its key covers every paragraph.
  const glossaryKey = await store.cacheKey(language, `glossary\n${current.paragraphs.map(p => p.text).join('\n')}`);
  const [glossary, ...cached] = await store.getCached([glossaryKey, ...keys]);
  if (doc !== current) return;
  current.glossaryKey = glossaryKey;
  current.glossary = glossary || null;
  current.paragraphs.forEach((p, i) => {
    current.keys.set(p.id, keys[i]);
    if (cached[i]) current.translations.set(p.id, cached[i]);
  });
  paintAll();
  renderGlossary();
}

/**
 * Translates the paragraphs not done yet, building the glossary first if there
 * is none. `only` translates just those paragraphs (again), with the glossary as
 * it is; `glossaryOnly` (re)builds the glossary and translates nothing.
 */
async function startTranslation({ only = null, glossaryOnly = false } = {}) {
  if (!doc) return;
  if (!isReady()) {
    openSettings();
    toast('먼저 API 키와 모델을 입력하세요.');
    return;
  }
  if (translator) {
    if (only) translator.add(only);
    return;
  }
  const current = doc;
  const todo = glossaryOnly ? [] : only ?? current.paragraphs.filter(p => !current.translations.has(p.id));
  const needGlossary = glossaryOnly || (!only && !current.glossary);
  if (!todo.length && !needGlossary) return;

  const run = new Translator({
    paragraphs: todo,
    title: current.title,
    settings,
    glossary: needGlossary ? null : current.glossary,
    glossarySource: needGlossary ? current.paragraphs : null,
  });
  translator = run;
  run.focus(currentPage());
  run.addEventListener('glossarystart', () => {
    current.glossaryBusy = true;
    renderGlossary();
    updateProgress();
  });
  run.addEventListener('glossary', ({ detail }) => {
    current.glossaryBusy = false;
    if (detail) {
      current.glossary = detail;
      store.putCached(current.glossaryKey, detail);
    }
    renderGlossary();
    updateProgress();
  });
  run.addEventListener('partial', ({ detail }) => {
    current.partial.set(detail.id, detail.text);
    if (tipId === detail.id) fillTip();
  });
  run.addEventListener('done', ({ detail }) => {
    current.translations.set(detail.id, detail.text);
    current.partial.delete(detail.id);
    store.putCached(current.keys.get(detail.id), detail.text);
    paint(detail.id);
    if (tipId === detail.id) fillTip();
    updateProgress();
  });
  run.addEventListener('progress', () => {
    for (const id of current.partial.keys()) if (!run.working.has(id)) current.partial.delete(id);
    paintAll();
    updateProgress();
    if (tipId) fillTip();
  });
  run.addEventListener('error', ({ detail }) => toast(detail.message, { error: true, sticky: detail.fatal }));
  paintAll();
  updateProgress();

  await run.run();
  if (translator === run) translator = null;
  current.glossaryBusy = false;
  if (doc === current) {
    current.partial.clear();
    paintAll();
    updateProgress();
    renderGlossary();
    if (tipId) fillTip();
  }
}

function stopTranslation() {
  if (!translator) return;
  translator.stop();
  translator = null;
  if (doc) {
    doc.partial.clear();
    doc.glossaryBusy = false;
    paintAll();
    renderGlossary();
  }
  updateProgress();
}

/** Starts over: drops this paper's translations and glossary, then translates everything again. */
async function retranslateAll() {
  if (!doc || translator) return;
  if (!isReady()) {
    openSettings();
    toast('먼저 API 키와 모델을 입력하세요.');
    return;
  }
  if (!confirm('이 논문의 모든 문단과 용어집을 새로 번역합니다. API 비용이 다시 듭니다. 계속할까요?')) return;
  const current = doc;
  await store.deleteCached([current.glossaryKey, ...current.keys.values()]);
  if (doc !== current) return;
  current.translations.clear();
  current.glossary = null;
  paintAll();
  renderGlossary();
  startTranslation();
}

const allTranslated = () => Boolean(doc?.paragraphs.length) && doc.translations.size >= doc.paragraphs.length;

function updateProgress() {
  const total = doc?.paragraphs.length || 0;
  const done = doc?.translations.size || 0;
  ui.progressBar.style.width = total ? pct(done, total) : '0';
  ui.translate.classList.toggle('running', Boolean(translator));
  if (translator) {
    ui.translate.textContent = '중지';
    ui.translate.disabled = false;
    setStatus(doc?.glossaryBusy ? '용어집 만드는 중…' : `번역 중 ${done}/${total}`);
  } else {
    ui.translate.textContent = allTranslated() ? '전체 다시 번역' : done ? '이어서 번역' : '번역 시작';
    ui.translate.disabled = !total;
    setStatus(total ? `번역 ${done}/${total}` : '');
  }
  $('glossary-btn').disabled = !doc;
  $('glossary-make').disabled = Boolean(translator);
  ui.keyState.textContent = isReady()
    ? `${PROVIDERS[settings.provider].label} · ${settings.models[settings.provider]} 사용`
    : 'API 키를 아직 입력하지 않았습니다.';
}

function setStatus(text) {
  ui.status.textContent = text;
}

// ---------------------------------------------------------------- tooltip

let tipId = null;
let tipBox = null;
let pinned = false;
let hideTimer = 0;

function showTip(box) {
  clearTimeout(hideTimer);
  if (tipId !== box.dataset.id) {
    highlight(tipId, false);
    tipId = box.dataset.id;
    highlight(tipId, true);
  }
  tipBox = box;
  ui.tip.hidden = false;
  fillTip();
}

function hideTip() {
  clearTimeout(hideTimer);
  highlight(tipId, false);
  tipId = tipBox = null;
  pinned = false;
  ui.tip.classList.remove('pinned');
  ui.tip.hidden = true;
}

function pin(box) {
  showTip(box);
  pinned = true;
  ui.tip.classList.add('pinned');
}

function fillTip() {
  const para = doc?.byId.get(tipId);
  if (!para) return;
  const text = doc.partial.get(tipId) || doc.translations.get(tipId);
  const busy = Boolean(translator?.pending.has(tipId));
  ui.tipBody.textContent = text || tipStatus(tipId);
  ui.tipBody.classList.toggle('muted', !text);
  ui.tip.classList.toggle('streaming', doc.partial.has(tipId));
  ui.tipMeta.textContent = `${para.page + 1}쪽${busy && doc.translations.has(tipId) ? ' · 다시 번역하는 중…' : ''}`;
  ui.tipRedo.textContent = doc.translations.has(tipId) ? '다시 번역' : '번역하기';
  ui.tipRedo.disabled = busy;
  placeTip();
}

function tipStatus(id) {
  if (translator?.working.has(id)) return '번역하는 중…';
  if (translator?.pending.has(id)) return '번역 대기 중…';
  if (!isReady()) return '오른쪽 위 설정에서 API 키와 모델을 입력한 뒤 ‘번역 시작’을 누르세요.';
  return '아직 번역하지 않은 문단입니다. ‘번역 시작’을 누르세요.';
}

/** Below the paragraph if it fits, otherwise above, otherwise against the bottom of the screen. */
function placeTip() {
  if (!tipBox || ui.tip.hidden) return;
  const r = tipBox.getBoundingClientRect();
  const gap = 8;
  const edge = 12;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const width = Math.min(Math.max(r.width, 380), 640, vw - 2 * edge);
  ui.tip.style.width = `${width}px`;
  const h = ui.tip.offsetHeight;
  let top = r.bottom + gap;
  if (top + h > vh - edge) top = r.top - gap - h >= edge ? r.top - gap - h : Math.max(edge, vh - edge - h);
  const left = clamp(r.left, edge, vw - edge - width);
  ui.tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

// The tooltip lets the pointer through until it is pinned, so moving down onto
// the next paragraph works even when the tooltip covers it.
ui.pages.addEventListener('pointerover', e => {
  const box = e.target.closest('.para');
  if (box && !pinned) showTip(box);
});

ui.pages.addEventListener('pointerout', e => {
  const box = e.target.closest('.para');
  if (!box || pinned || e.relatedTarget?.closest?.('.para')?.dataset.id === box.dataset.id) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTip, 150);
});

ui.pages.addEventListener('click', e => {
  const box = e.target.closest('.para');
  if (!box) hideTip();
  else if (pinned && tipId === box.dataset.id) hideTip();
  else pin(box);
});

ui.pages.addEventListener('keydown', e => {
  const box = e.target.closest('.para');
  if (box && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    pinned && tipId === box.dataset.id ? hideTip() : pin(box);
  }
});

ui.pages.addEventListener('focusin', e => {
  const box = e.target.closest('.para');
  if (box && !pinned) showTip(box);
});

ui.pages.addEventListener('focusout', e => {
  if (!pinned && !e.relatedTarget?.closest?.('.para')) hideTip();
});

document.addEventListener('click', e => {
  if (pinned && !ui.tip.contains(e.target) && !ui.pages.contains(e.target)) hideTip();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !ui.dialog.open) hideTip();
});

$('tip-copy').addEventListener('click', async () => {
  const text = doc?.translations.get(tipId);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('번역을 복사했습니다.');
  } catch {
    toast('복사하지 못했습니다.', { error: true });
  }
});

$('tip-close').addEventListener('click', hideTip);

ui.tipRedo.addEventListener('click', () => {
  const para = doc?.byId.get(tipId);
  if (para) startTranslation({ only: [para] });
});

// ---------------------------------------------------------------- settings

let draft = null;

function openSettings() {
  draft = structuredClone(settings);
  ui.form.elements.provider.value = draft.provider;
  fillProviderFields();
  $('language').value = draft.language;
  $('notes').value = draft.notes;
  $('remember').checked = draft.rememberKeys;
  $('api-key').type = 'password';
  $('toggle-key').textContent = '보기';
  ui.dialog.returnValue = '';
  ui.dialog.showModal();
}

function fillProviderFields() {
  const id = draft.provider;
  const api = PROVIDERS[id];
  $('base-url-field').hidden = !isCompatible(id);
  $('base-url').required = isCompatible(id);
  $('base-url').value = draft.baseUrls[id] || '';
  $('api-key').value = draft.keys[id];
  $('api-key').placeholder = api.keyPlaceholder;
  $('key-link').hidden = !api.keyUrl;
  $('key-link').href = api.keyUrl || '#';
  $('model').placeholder = api.models.length ? '모델 이름' : '모델 이름 (‘목록 불러오기’로 찾기)';
  setModelOptions(loadedModels.get(id) || api.models, draft.models[id]);
}

function readProviderFields() {
  const id = draft.provider;
  draft.keys[id] = $('api-key').value.trim();
  draft.models[id] = $('model').value.trim();
  if (isCompatible(id)) draft.baseUrls[id] = $('base-url').value.trim();
}

// Model lists fetched with "목록 불러오기", per provider, for this visit.
const loadedModels = new Map();
const TYPE_MODEL = ''; // value of the menu's "직접 입력…" entry

/** Fills the model menu. A model that isn't on it is typed into the box below. */
function setModelOptions(models, current) {
  current ||= models[0] || '';
  const select = $('model-select');
  select.replaceChildren(...models.map(id => new Option(id, id)), new Option('직접 입력…', TYPE_MODEL));
  select.value = models.includes(current) ? current : TYPE_MODEL;
  $('model').value = current;
  $('model').hidden = select.value !== TYPE_MODEL;
}

$('model-select').addEventListener('change', e => {
  const typed = e.target.value === TYPE_MODEL;
  if (!typed) $('model').value = e.target.value;
  $('model').hidden = !typed;
  if (typed) $('model').focus();
});

ui.form.addEventListener('change', e => {
  if (e.target.name !== 'provider') return;
  readProviderFields();
  draft.provider = e.target.value;
  fillProviderFields();
});

ui.dialog.addEventListener('close', async () => {
  if (ui.dialog.returnValue !== 'save') return;
  readProviderFields();
  draft.language = $('language').value;
  draft.notes = $('notes').value;
  draft.rememberKeys = $('remember').checked;
  const languageChanged = draft.language !== settings.language;
  settings = draft;
  store.saveSettings(settings);
  if (doc && languageChanged) {
    stopTranslation();
    doc.translations.clear();
    await loadCachedTranslations();
  }
  updateProgress();
  if (tipId) fillTip();
});

$('settings-cancel').addEventListener('click', () => ui.dialog.close('cancel'));

$('toggle-key').addEventListener('click', e => {
  const input = $('api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
  e.currentTarget.textContent = input.type === 'password' ? '보기' : '숨기기';
});

$('load-models').addEventListener('click', async e => {
  const key = $('api-key').value.trim();
  const baseUrl = $('base-url').value.trim();
  if (!key || (isCompatible(draft.provider) && !baseUrl)) {
    toast(key ? '먼저 API 주소를 입력하세요.' : '먼저 API 키를 입력하세요.');
    return;
  }
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const models = await listModels(draft.provider, key, baseUrl);
    if (models.length) loadedModels.set(draft.provider, models);
    setModelOptions(models.length ? models : PROVIDERS[draft.provider].models, $('model').value.trim());
    $('model-select').focus();
    toast(`모델 ${models.length}개를 불러왔습니다. 목록에서 고르세요.`);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    button.disabled = false;
  }
});

$('clear-cache').addEventListener('click', async () => {
  await store.clearCache();
  if (doc) {
    stopTranslation();
    doc.translations.clear();
    doc.glossary = null;
    paintAll();
    updateProgress();
    renderGlossary();
  }
  toast('저장된 번역과 용어집을 모두 지웠습니다.');
});

$('language').replaceChildren(...store.LANGUAGES.map(([value, label]) => new Option(label, value)));

// The three native APIs first, then the OpenAI-compatible ones.
$('provider').replaceChildren(...[['main', '주요 제공자'], ['compatible', 'OpenAI 호환 API']].map(([group, label]) => {
  const optgroup = document.createElement('optgroup');
  optgroup.label = label;
  for (const [id, p] of Object.entries(PROVIDERS)) if (p.group === group) optgroup.append(new Option(p.label, id));
  return optgroup;
}));

// ---------------------------------------------------------------- glossary

function renderGlossary() {
  const entries = doc?.glossary;
  const busy = Boolean(doc?.glossaryBusy);
  $('glossary-count').textContent = entries?.length ? `${entries.length}개` : '';
  $('glossary-copy').hidden = !entries?.length || busy;
  $('glossary-make').hidden = !doc || busy;
  $('glossary-make').textContent = entries ? '다시 만들기' : '용어집 만들기';
  const body = $('glossary-body');
  if (!doc) body.replaceChildren(glossaryMessage('PDF를 열면 그 논문의 용어집을 볼 수 있습니다.'));
  else if (busy) body.replaceChildren(glossaryMessage('논문 전체에서 핵심 용어를 정리하는 중…'));
  else if (!entries) {
    body.replaceChildren(glossaryMessage('아직 용어집이 없습니다. ‘번역 시작’을 누르면 먼저 논문 전체에서 핵심 용어를 정리하고, 모든 문단을 이 용어에 맞춰 번역합니다.'));
  } else if (!entries.length) body.replaceChildren(glossaryMessage('정리할 용어를 찾지 못했습니다.'));
  else body.replaceChildren(...entries.map(glossaryItem));
}

const glossaryMessage = text => Object.assign(document.createElement('p'), { className: 'glossary-message', textContent: text });

function glossaryItem({ term, translation, note }) {
  const item = document.createElement('div');
  item.className = 'term';
  const head = document.createElement('div');
  head.className = 'term-head';
  head.append(
    Object.assign(document.createElement('span'), { className: 'term-src', textContent: term }),
    Object.assign(document.createElement('span'), { className: 'term-dst', textContent: translation }),
  );
  item.append(head);
  if (note) item.append(Object.assign(document.createElement('p'), { className: 'term-note', textContent: note }));
  return item;
}

function toggleGlossary(open) {
  $('glossary').hidden = !open;
  $('glossary-btn').setAttribute('aria-expanded', String(open));
  // On wide screens the panel takes room from the pages instead of covering them.
  document.body.classList.toggle('glossary-open', open);
  if (open) renderGlossary();
  if (doc && fitWidth) applyZoom(fitZoom());
  else placeTip();
}

$('glossary-btn').addEventListener('click', () => toggleGlossary($('glossary').hidden));
$('glossary-close').addEventListener('click', () => toggleGlossary(false));
$('glossary-make').addEventListener('click', () => startTranslation({ glossaryOnly: true }));

$('glossary-copy').addEventListener('click', async () => {
  // Tab-separated, so it pastes into a spreadsheet as columns.
  const text = (doc?.glossary || []).map(g => [g.term, g.translation, g.note].filter(Boolean).join('\t')).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('용어집을 복사했습니다.');
  } catch {
    toast('복사하지 못했습니다.', { error: true });
  }
});

// ---------------------------------------------------------------- misc UI

let toastTimer = 0;

/** Shown as a popover so it also appears above the settings dialog. */
function toast(message, { error = false, sticky = false } = {}) {
  ui.toast.querySelector('.toast-text').textContent = message;
  ui.toast.classList.toggle('error', error);
  if (ui.toast.matches(':popover-open')) ui.toast.hidePopover();
  ui.toast.showPopover();
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => ui.toast.hidePopover(), error ? 9000 : 3500);
}

ui.toast.querySelector('.toast-close').addEventListener('click', () => ui.toast.hidePopover());

for (const id of ['open', 'empty-open']) $(id).addEventListener('click', () => ui.fileInput.click());
for (const id of ['settings-btn', 'empty-settings']) $(id).addEventListener('click', openSettings);

ui.fileInput.addEventListener('change', () => {
  openFile(ui.fileInput.files[0]);
  ui.fileInput.value = '';
});

ui.translate.addEventListener('click', () => {
  if (translator) stopTranslation();
  else if (allTranslated()) retranslateAll();
  else startTranslation();
});

$('zoom-in').addEventListener('click', () => {
  fitWidth = false;
  applyZoom(zoom * 1.2);
});
$('zoom-out').addEventListener('click', () => {
  fitWidth = false;
  applyZoom(zoom / 1.2);
});
ui.zoomFit.addEventListener('click', () => {
  if (!doc) return;
  fitWidth = true;
  applyZoom(fitZoom());
});

let scrollFrame = 0;
ui.viewer.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!doc) return;
    const page = currentPage();
    ui.pageInfo.textContent = `${page + 1} / ${doc.pages.length}`;
    translator?.focus(page);
    placeTip();
  });
}, { passive: true });

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => (doc && fitWidth ? applyZoom(fitZoom()) : placeTip()), 150);
});

// Dropping a file anywhere opens it.
let dragDepth = 0;
const draggingFiles = e => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', e => {
  if (!draggingFiles(e)) return;
  dragDepth++;
  ui.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', e => {
  if (draggingFiles(e) && --dragDepth <= 0) {
    dragDepth = 0;
    ui.dropOverlay.hidden = true;
  }
});
window.addEventListener('dragover', e => {
  if (draggingFiles(e)) e.preventDefault();
});
window.addEventListener('drop', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  ui.dropOverlay.hidden = true;
  const file = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (file) openFile(file);
  else toast('PDF 파일을 놓아 주세요.', { error: true });
});

updateProgress();

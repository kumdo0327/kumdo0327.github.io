// Sends paragraphs to the model page by page and hands translations back as
// they stream in. A full run first asks for a glossary of the paper's key terms,
// and every page is then translated with it, so a term reads the same throughout.
// Each request also carries some context (the abstract, the section, the paragraph
// before), and a translation that slips into another script is asked for once more.

import { streamCompletion } from './llm.js';

const MAX_BATCH_CHARS = 6000;
const CONCURRENCY = 3;
const GLOSSARY_SOURCE_CHARS = 120_000; // paper text sent when building the glossary
const GLOSSARY_MAX_TERMS = 40;
const MARKER = /\[\[\s*(p\d+)\s*\]\]/g;
const ROLE_NAMES = { title: 'title', heading: 'heading', caption: 'caption', list: 'list item' };

// Scripts that don't belong in a translation into each language, unless the source has them too.
const FOREIGN_SCRIPTS = {
  Korean: /[\u3040-\u30FF\u4E00-\u9FFF]/g, // kana, CJK ideographs
  Japanese: /[\uAC00-\uD7A3]/g, // hangul
  'Simplified Chinese': /[\u3040-\u30FF\uAC00-\uD7A3]/g,
  'Traditional Chinese': /[\u3040-\u30FF\uAC00-\uD7A3]/g,
};
const CJK_SCRIPTS = /[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7A3]/g; // for languages written in Latin script

const readerNotes = notes => (notes.trim() ? `\n\nInstructions from the reader, which take precedence:\n${notes.trim()}` : '');

export function buildPrompt(paragraphs, { title, language, notes, glossary, context = {} }) {
  const terms = glossary?.length
    ? `\n\nUse these translations of the paper's key terms throughout:\n${glossary.map(g => `- ${g.term}: ${g.translation}`).join('\n')}`
    : '';
  const system = `You translate academic papers. Translate each paragraph you are given into ${language}.

- Translate faithfully and completely in a natural academic register. Do not summarize, explain or add notes.
- Keep formulas, symbols, variable names, citations such as [12] or (Smith et al., 2020), URLs and code exactly as they are. Subscripts and superscripts are written _{…} and ^{…}; keep them as they are.
- Use the established ${language} term for technical terms; if there is none, keep the English term.
- Write in ${language} only. Apart from technical terms kept in English, do not switch to another language or script mid-sentence.
- Translate a heading as a heading and keep its number; a caption with its label and number (Fig. 3, Table II) in the usual ${language} form; a list item as a list item.
- The text was extracted from a PDF, so it can contain stray formula symbols or footnote marks. Translate what the author meant and leave such symbols as they are.
- Context given for reference (the abstract, the current section, the paragraph just before) only helps you resolve references and keep the tone. Do not translate it.
- Reply with the paragraphs in the given order. Start each one with its marker on a line of its own, exactly as given, and write nothing else:
[[p1]]
(translation of p1)
[[p2]]
(translation of p2)${terms}${readerNotes(notes)}`;

  const parts = title ? [`Paper: ${title}`] : [];
  const reference = [
    context.abstract && `Abstract: ${context.abstract}`,
    context.section && `Current section: ${context.section}`,
    context.previous && `Paragraph just before: ${context.previous}`,
  ].filter(Boolean);
  if (reference.length) parts.push(`For reference only:\n${reference.join('\n')}`);
  const roles = paragraphs.filter(p => ROLE_NAMES[p.role]).map(p => `${p.id} ${ROLE_NAMES[p.role]}`);
  if (roles.length) parts.push(`Not running text: ${roles.join('; ')}`);
  parts.push(`Translate:\n\n${paragraphs.map(p => `[[${p.id}]]\n${p.text}`).join('\n\n')}`);
  return { system, prompt: parts.join('\n\n') };
}

/** The abstract, if the paper has one: "Abstract—…", or the paragraph under an "Abstract" heading. */
function findAbstract(doc) {
  const i = doc.findIndex(p => /^abstract\b/i.test(p.text));
  if (i < 0) return null;
  return doc[i].text.length > 200 ? doc[i] : doc[i + 1] || null;
}

/** 1 for "3" or "III.", 2 for "3.2" or "B.", 0 for an unnumbered heading. */
function headingLevel(text) {
  const number = text.match(/^(\d+(?:\.\d+)*)\.?\s/);
  if (number) return number[1].split('.').length;
  if (/^[IVX]+\.\s/.test(text)) return 1;
  if (/^[A-Z]\.\s/.test(text)) return 2;
  return 0;
}

/** "III. Examining … > B. Crafting …": the heading a paragraph falls under, with its parent. */
function sectionOf(doc, index) {
  let i = index - 1;
  while (i >= 0 && doc[i].role !== 'heading') i--;
  if (i < 0) return '';
  const level = headingLevel(doc[i].text);
  let parent = null;
  for (let j = i - 1; level > 1 && j >= 0 && !parent; j--) {
    const l = doc[j].role === 'heading' ? headingLevel(doc[j].text) : 0;
    if (l && l < level) parent = doc[j];
  }
  return [parent, doc[i]].filter(Boolean).map(p => p.text.slice(0, 100)).join(' > ');
}

/** Asks for the paper's key terms, each with its translation and a short note. */
export async function makeGlossary({ paragraphs, title, settings, signal }) {
  const { provider, keys, models, baseUrls, language, notes } = settings;
  const system = `You build a glossary for readers of an academic paper.

- Pick the paper's key technical terms, at most ${GLOSSARY_MAX_TERMS}: concepts, methods, named models and datasets, metrics. Skip everyday words.
- Give each the established ${language} translation used in the field. If the field usually keeps the English term, keep it.
- Add a short note, under 20 words, on what the term means in this paper. Write the notes entirely in ${language}.
- Reply with only a JSON array, in order of first appearance:
[{"term": "...", "translation": "...", "note": "..."}]${readerNotes(notes)}`;
  const text = paragraphs.map(p => p.text).join('\n\n').slice(0, GLOSSARY_SOURCE_CHARS);
  const reply = await streamCompletion({
    provider,
    apiKey: keys[provider],
    model: models[provider],
    baseUrl: baseUrls[provider],
    system,
    prompt: (title ? `Paper: ${title}\n\n` : '') + text,
    signal,
    onText: () => {},
  });
  return parseGlossary(reply);
}

/** The entries of a glossary reply, allowing for code fences or words around the JSON. */
export function parseGlossary(reply) {
  let items;
  try {
    items = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1));
  } catch {
    throw new Error('용어집 응답을 읽지 못했습니다.');
  }
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .filter(g => typeof g?.term === 'string' && typeof g?.translation === 'string')
    .map(g => ({ term: g.term.trim(), translation: g.translation.trim(), note: typeof g.note === 'string' ? g.note.trim() : '' }))
    .filter(g => g.term && g.translation && !seen.has(g.term.toLowerCase()) && seen.add(g.term.toLowerCase()))
    .slice(0, GLOSSARY_MAX_TERMS);
}

/** Splits a streamed reply into paragraphs by their [[pN]] markers. */
export class MarkerParser {
  constructor(ids) {
    this.ids = new Set(ids);
    this.seen = new Set();
    this.current = null;
    this.buffer = '';
  }

  /** @returns {{id: string, text: string, done: boolean}[]} finished paragraphs, then the one in progress */
  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let start = 0;
    for (const m of this.buffer.matchAll(MARKER)) {
      this.finish(this.current, this.buffer.slice(start, m.index), out);
      this.current = m[1];
      start = m.index + m[0].length;
    }
    this.buffer = this.buffer.slice(start);
    if (this.current && this.ids.has(this.current) && !this.seen.has(this.current)) {
      // Hide a marker that has only partly arrived.
      out.push({ id: this.current, text: clean(this.buffer.replace(/\[\[[^\]]*\]?$/, '')), done: false });
    }
    return out;
  }

  end() {
    const out = [];
    this.finish(this.current, this.buffer, out);
    this.current = null;
    return out;
  }

  finish(id, text, out) {
    text = clean(text);
    if (id && text && this.ids.has(id) && !this.seen.has(id)) {
      this.seen.add(id);
      out.push({ id, text, done: true });
    }
  }
}

const clean = text => text.replace(/^```\w*$/gm, '').trim();

/**
 * Translates paragraphs in batches of one page (or less, for dense pages),
 * a few at a time, starting near the page in focus. Given the whole paper as
 * `glossarySource` and no glossary, it builds the glossary first.
 *
 * Events: "partial" and "done" ({id, text}), "progress", "error" ({message, fatal}),
 * "glossarystart", and "glossary" (the entries, or null if none could be built).
 */
export class Translator extends EventTarget {
  /** `document` is every paragraph of the paper, which the context is drawn from. */
  constructor({ paragraphs, title, settings, glossary = null, glossarySource = null, document = paragraphs }) {
    super();
    this.title = title;
    this.document = document;
    this.position = new Map(document.map((p, i) => [p.id, i]));
    this.abstractParagraph = findAbstract(document);
    this.settings = structuredClone(settings); // later edits in the settings dialog don't affect a run
    this.glossary = glossary;
    this.glossarySource = glossarySource;
    this.queue = makeBatches(paragraphs);
    this.pending = new Set(paragraphs.map(p => p.id));
    this.working = new Set();
    this.focusPage = 0;
    this.abort = new AbortController();
    this.started = false;
    this.workers = 0;
    this.finished = new Promise(resolve => (this.finish = resolve));
  }

  focus(page) {
    this.focusPage = page;
  }

  /** Resolves when every paragraph is translated or given up on, or after stop(). */
  async run() {
    if (this.glossarySource && !this.glossary) await this.buildGlossary();
    this.started = true;
    this.spawn();
    return this.finished;
  }

  /** Queues more paragraphs while the run goes on, such as one to translate again. */
  add(paragraphs) {
    const fresh = paragraphs.filter(p => !this.pending.has(p.id));
    for (const p of fresh) this.pending.add(p.id);
    this.queue.push(...makeBatches(fresh));
    if (this.started) this.spawn();
    this.emit('progress');
  }

  stop() {
    this.abort.abort();
    this.queue = [];
    this.finish();
  }

  spawn() {
    while (!this.abort.signal.aborted && this.workers < CONCURRENCY && this.queue.length) {
      this.workers++;
      this.worker().finally(() => {
        if (--this.workers === 0) this.finish();
      });
    }
    if (this.workers === 0) this.finish();
  }

  async worker() {
    while (!this.abort.signal.aborted) {
      const batch = this.next();
      if (!batch) return;
      await this.translate(batch);
    }
  }

  async buildGlossary() {
    this.emit('glossarystart');
    try {
      this.glossary = await makeGlossary({
        paragraphs: this.glossarySource,
        title: this.title,
        settings: this.settings,
        signal: this.abort.signal,
      });
    } catch (err) {
      if (this.abort.signal.aborted) return;
      if (err.fatal) {
        this.stop();
        this.emit('error', { message: err.message, fatal: true });
      } else {
        const rest = this.queue.length ? ' 용어집 없이 번역합니다.' : '';
        this.emit('error', { message: `용어집을 만들지 못했습니다: ${err.message}${rest}`, fatal: false });
      }
    }
    this.emit('glossary', this.glossary);
  }

  /** The waiting batch closest to the page being read, the next page before the previous one. */
  next() {
    if (!this.queue.length) return null;
    const score = b => Math.abs(b.page - this.focusPage) - (b.page > this.focusPage ? 0.5 : 0);
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) if (score(this.queue[i]) < score(this.queue[best])) best = i;
    return this.queue.splice(best, 1)[0];
  }

  /** Context for a batch: the abstract, the section it starts in, and the end of the paragraph before it. */
  contextFor(batch) {
    const index = this.position.get(batch.paras[0].id) ?? -1;
    const before = this.document[index - 1];
    const abstract = this.abstractParagraph && !batch.paras.includes(this.abstractParagraph)
      ? this.abstractParagraph.text.replace(/^abstract\W*/i, '').slice(0, 1500)
      : '';
    return {
      abstract,
      section: index > 0 ? sectionOf(this.document, index) : '',
      previous: before && before.role !== 'heading' ? before.text.slice(-800) : '',
    };
  }

  /** How wrong a translation looks: letters in a script foreign to it, or far too short for its source. */
  flaws(source, translation) {
    const foreign = FOREIGN_SCRIPTS[this.settings.language] ?? CJK_SCRIPTS;
    const count = text => (text.match(foreign) || []).length;
    const stray = count(source) ? 0 : count(translation);
    const truncated = source.length >= 300 && translation.length < source.length * 0.15;
    return stray + (truncated ? 1000 : 0);
  }

  async translate(batch) {
    const { provider, keys, models, baseUrls, language, notes } = this.settings;
    const { system, prompt } = buildPrompt(batch.paras, {
      title: this.title, language, notes, glossary: this.glossary, context: this.contextFor(batch),
    });
    const parser = new MarkerParser(batch.paras.map(p => p.id));
    for (const p of batch.paras) this.working.add(p.id);
    this.emit('progress');
    const deliver = updates => {
      for (const u of updates) {
        if (!u.done) {
          this.emit('partial', u);
          continue;
        }
        const para = batch.paras.find(p => p.id === u.id);
        let text = u.text;
        this.working.delete(u.id);
        if (batch.earlier) {
          // The second attempt: keep whichever reads better.
          if (this.flaws(para.text, batch.earlier) <= this.flaws(para.text, text)) text = batch.earlier;
        } else if (this.flaws(para.text, text)) {
          // Show it for now, and ask once more for this paragraph on its own.
          this.queue.push({ page: batch.page, paras: [para], chars: para.text.length, attempt: 1, earlier: text });
          this.emit('done', { id: u.id, text });
          continue;
        }
        this.pending.delete(u.id);
        this.emit('done', { id: u.id, text });
      }
    };
    try {
      await streamCompletion({
        provider,
        apiKey: keys[provider],
        model: models[provider],
        baseUrl: baseUrls[provider],
        system,
        prompt,
        signal: this.abort.signal,
        onText: chunk => deliver(parser.push(chunk)),
      });
      deliver(parser.end());
      const missing = batch.paras.filter(p => !parser.seen.has(p.id));
      // A failed second attempt leaves the first translation in place.
      if (missing.length && batch.earlier) this.settle(missing);
      else if (missing.length) this.retry({ ...batch, paras: missing }, '일부 문단의 번역이 빠졌습니다.');
    } catch (err) {
      if (this.abort.signal.aborted) return;
      const missing = batch.paras.filter(p => !parser.seen.has(p.id));
      if (err.fatal) {
        this.stop();
        this.emit('error', { message: err.message, fatal: true });
      } else if (batch.earlier) {
        this.settle(missing);
      } else if (err.content && missing.length > 1) {
        // One paragraph was declined; send the rest one by one so only that one is lost.
        for (const p of missing) this.queue.push({ page: batch.page, paras: [p], chars: p.text.length, attempt: 1 });
      } else if (err.content) {
        this.fail(missing, err.message);
      } else {
        this.retry({ ...batch, paras: missing }, err.message);
      }
    } finally {
      for (const p of batch.paras) this.working.delete(p.id);
      this.emit('progress');
    }
  }

  retry(batch, message) {
    if (batch.attempt < 1) this.queue.push({ ...batch, attempt: batch.attempt + 1 });
    else this.fail(batch.paras, message);
  }

  fail(paras, message) {
    this.settle(paras);
    this.emit('error', { message: `${paras.length}개 문단을 번역하지 못했습니다: ${message}`, fatal: false });
  }

  settle(paras) {
    for (const p of paras) this.pending.delete(p.id);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function makeBatches(paragraphs) {
  const batches = [];
  let batch = null;
  for (const p of paragraphs) {
    if (!batch || batch.page !== p.page || batch.chars + p.text.length > MAX_BATCH_CHARS) {
      batch = { page: p.page, paras: [], chars: 0, attempt: 0 };
      batches.push(batch);
    }
    batch.paras.push(p);
    batch.chars += p.text.length;
  }
  return batches;
}

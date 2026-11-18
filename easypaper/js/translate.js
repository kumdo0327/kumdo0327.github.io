// Sends paragraphs to the model page by page and hands translations back as they stream in.

import { streamCompletion } from './llm.js';

const MAX_BATCH_CHARS = 6000;
const CONCURRENCY = 3;
const MARKER = /\[\[\s*(p\d+)\s*\]\]/g;

export function buildPrompt(paragraphs, { title, language, notes }) {
  const system = `You translate academic papers. Translate each paragraph you are given into ${language}.

- Translate faithfully and completely in a natural academic register. Do not summarize, explain or add notes.
- Keep formulas, symbols, variable names, citations such as [12] or (Smith et al., 2020), URLs and code exactly as they are.
- Use the established ${language} term for technical terms; if there is none, keep the English term.
- The text was extracted from a PDF, so it can contain stray formula symbols or footnote marks. Translate what the author meant and leave such symbols as they are.
- Reply with the paragraphs in the given order. Start each one with its marker on a line of its own, exactly as given, and write nothing else:
[[p1]]
(translation of p1)
[[p2]]
(translation of p2)${notes.trim() ? `\n\nInstructions from the reader, which take precedence:\n${notes.trim()}` : ''}`;

  const prompt = (title ? `Paper: ${title}\n\n` : '') + paragraphs.map(p => `[[${p.id}]]\n${p.text}`).join('\n\n');
  return { system, prompt };
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
 * a few at a time, starting near the page in focus.
 *
 * Events: "partial" and "done" ({id, text}), "progress", "error" ({message, fatal}).
 */
export class Translator extends EventTarget {
  constructor({ paragraphs, title, settings }) {
    super();
    this.title = title;
    this.settings = structuredClone(settings); // later edits in the settings dialog don't affect a run
    this.queue = makeBatches(paragraphs);
    this.pending = new Set(paragraphs.map(p => p.id));
    this.working = new Set();
    this.focusPage = 0;
    this.abort = new AbortController();
  }

  focus(page) {
    this.focusPage = page;
  }

  /** Resolves when every paragraph is translated or given up on, or after stop(). */
  async run() {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => this.worker()));
  }

  stop() {
    this.abort.abort();
    this.queue = [];
  }

  async worker() {
    while (!this.abort.signal.aborted) {
      const batch = this.next();
      if (!batch) return;
      await this.translate(batch);
    }
  }

  /** The waiting batch closest to the page being read, the next page before the previous one. */
  next() {
    if (!this.queue.length) return null;
    const score = b => Math.abs(b.page - this.focusPage) - (b.page > this.focusPage ? 0.5 : 0);
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) if (score(this.queue[i]) < score(this.queue[best])) best = i;
    return this.queue.splice(best, 1)[0];
  }

  async translate(batch) {
    const { provider, keys, models, language, notes } = this.settings;
    const { system, prompt } = buildPrompt(batch.paras, { title: this.title, language, notes });
    const parser = new MarkerParser(batch.paras.map(p => p.id));
    for (const p of batch.paras) this.working.add(p.id);
    this.emit('progress');
    const deliver = updates => {
      for (const u of updates) {
        if (u.done) {
          this.pending.delete(u.id);
          this.working.delete(u.id);
        }
        this.emit(u.done ? 'done' : 'partial', u);
      }
    };
    try {
      await streamCompletion({
        provider,
        apiKey: keys[provider],
        model: models[provider],
        system,
        prompt,
        signal: this.abort.signal,
        onText: chunk => deliver(parser.push(chunk)),
      });
      deliver(parser.end());
      const missing = batch.paras.filter(p => !parser.seen.has(p.id));
      if (missing.length) this.retry({ ...batch, paras: missing }, '일부 문단의 번역이 빠졌습니다.');
    } catch (err) {
      if (this.abort.signal.aborted) return;
      const missing = batch.paras.filter(p => !parser.seen.has(p.id));
      if (err.fatal) {
        this.stop();
        this.emit('error', { message: err.message, fatal: true });
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
    for (const p of paras) this.pending.delete(p.id);
    this.emit('error', { message: `${paras.length}개 문단을 번역하지 못했습니다: ${message}`, fatal: false });
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

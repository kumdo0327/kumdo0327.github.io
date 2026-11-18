// Turns PDF.js text content into translatable paragraphs.
//
// Everything here works in PDF user space (points, origin at the bottom-left)
// and touches no DOM, so the same code also runs under Node for testing.

// Sentence end, allowing for a closing quote or bracket and a footnote mark after it.
const TERMINAL = /[.!?:]["'”’)\]]*(\^\{[^{}]*\})?$/;
const LIGATURES = /[\uFB00-\uFB06]/g;
const ONLY_DIGITS = /^\d{1,4}$/;
// A caption numbers itself and then breaks off ("Fig. 3.", "Table 2:"); "Fig. 3 shows" is running text.
const CAPTION = /^(figure|fig\.|table|algorithm|listing)\s*(\d+|[IVX]+)\s*[.:]/i;
const CAPS_TABLE_CAPTION = /^TABLE\s+([IVX]+|\d+)\s+[A-Z]{2,}/; // IEEE style: "TABLE II" over a title in small caps
const NUMBERED_HEADING = /^((\d+|[A-Z])(\.\d+)*\.?|[IVX]+\.)\s+\p{Lu}/u;
const NAMED_HEADING = /^(abstract|introduction|background|related work|conclusions?|discussion|limitations|acknowledge?ments?|references|bibliography|appendix)\b/i;
const LIST_ITEM = /^([•◦▪–*-]|\(?[a-z\d]{1,3}\))\s/i;
const REFERENCES_HEADING = /^(\d+\.?\s*)?(references|bibliography|참고\s*문헌)$/i;
const APPENDIX_HEADING = /^(appendix|appendices|supplementary)\b|^[A-Z](\.\d+)*\s+[A-Z][^,.]*$/i;
// Words a paragraph cannot end on, so the text must go on in another column.
const FUNCTION_WORDS = new Set(('a an the of to in on for with by as at from and or but nor that which ' +
  'whose whom who is are was were be been being this these those its their our your his her we can ' +
  'could may might will would should must than into onto via between such not also both either each').split(' '));

/** Lines of one page, in content-stream order. */
export function pageLines(textContent) {
  const lines = [];
  let line = null;
  for (const item of textContent.items) {
    const run = toRun(item);
    if (!run) continue;
    if (line && sameLine(line, run)) addRun(line, run);
    else lines.push(line = { runs: [run], x0: run.x0, x1: run.x1, base: run.base, fs: run.fs, text: run.str, mark: false });
  }
  // Bare numbers are page or line numbers; they would only split paragraphs.
  return lines.map(finishLine).filter(l => l.text && !ONLY_DIGITS.test(l.plain));
}

function toRun(item) {
  if (!item.str || !item.str.trim() || item.dir === 'ttb') return null;
  const [a, b, c, d, e, f] = item.transform;
  // Rotated text, such as the arXiv identifier up the left margin, is not body text.
  if (a <= 0 || d <= 0 || Math.abs(b) > a * 0.05 || Math.abs(c) > d * 0.05) return null;
  const fs = Math.round(Math.hypot(c, d) * 100) / 100;
  if (!(fs > 0)) return null;
  const str = item.str.replace(LIGATURES, ch => ch.normalize('NFKC'));
  return { str, x0: e, x1: e + item.width, base: f, fs, font: item.fontName };
}

function sameLine(line, run) {
  const fs = Math.max(line.fs, run.fs);
  const gap = run.x0 - line.x1;
  // The baseline tolerance keeps sub- and superscripts on their line. The gap
  // limit keeps two columns apart, but allows a wide justified space after a sentence.
  const maxGap = TERMINAL.test(line.text) ? 1.6 * fs : 1.3 * fs;
  return Math.abs(run.base - line.base) < 0.55 * fs && gap > -0.5 * fs && gap < maxGap;
}

function addRun(line, run) {
  const prev = line.runs[line.runs.length - 1];
  // A raised, smaller first run is a footnote mark ("¹The GLUE data…").
  const mark = line.runs.length === 1 && prev.fs < run.fs * 0.85 && prev.base > run.base + 0.2 * run.fs;
  // A large first letter (drop cap) belongs to the word after it ("S" + "TATIC").
  const dropCap = line.runs.length === 1 && prev.str.trim().length === 1 && prev.fs > run.fs * 1.8;
  const gap = run.x0 - line.x1;
  run.space = (mark || gap > 0.12 * Math.min(line.fs, run.fs)) && !dropCap && !/\s$/.test(line.text) && !/^\s/.test(run.str);
  line.text += (run.space ? ' ' : '') + run.str;
  line.runs.push(run);
  line.mark ||= mark;
  line.x0 = Math.min(line.x0, run.x0);
  line.x1 = Math.max(line.x1, run.x1);
  if (run.fs > line.fs * 1.05) {
    line.fs = run.fs;
    line.base = run.base;
  }
}

function finishLine(line) {
  // The size and font covering the most characters, so footnote marks,
  // big operators and the odd bold word don't count.
  const fs = dominant(line.runs.map(r => [r.fs, r.str.trim().length]));
  const base = line.runs.find(r => r.fs === fs).base;
  return {
    text: scriptText(line.runs, fs, base),
    plain: line.text.replace(/\s+/g, ' ').trim(),
    x0: line.x0,
    x1: line.x1,
    base,
    fs,
    font: dominant(line.runs.map(r => [r.font, r.str.trim().length])),
    mark: line.mark,
    top: Math.max(...line.runs.map(r => r.base + 0.8 * r.fs)),
    bottom: Math.min(...line.runs.map(r => r.base - 0.25 * r.fs)),
  };
}

/**
 * The line's text with sub- and superscripts marked the way LaTeX writes them
 * ("d_{model}", "removed_{fix}", "left.^{4}"), so notation and footnote marks
 * survive translation. A script is a smaller run raised or lowered off the baseline.
 */
function scriptText(runs, fs, base) {
  let text = '';
  let script = '';
  for (const r of runs) {
    const s = r.fs >= fs * 0.85 ? '' : r.base > base + 0.15 * fs ? '^' : r.base < base - 0.1 * fs ? '_' : '';
    if (s !== script) {
      if (script) text += '}';
      if (r.space && !s) text += ' '; // a script hangs on the word before it
      if (s) text += `${s}{`;
      script = s;
    } else if (r.space) {
      text += ' ';
    }
    text += s ? r.str.trim() : r.str;
  }
  if (script) text += '}';
  return text.replace(/\s+/g, ' ').trim();
}

/** The key with the largest total weight among [key, weight] pairs. */
function dominant(pairs) {
  const total = new Map();
  for (const [key, weight] of pairs) total.set(key, (total.get(key) || 0) + weight);
  let best = pairs[0][0];
  for (const [key, weight] of total) if (weight > total.get(best)) best = key;
  return best;
}

/** Typical baseline distance as a multiple of the font size. */
function leadingRatio(pages) {
  const ratios = [];
  for (const { lines } of pages) {
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1], line = lines[i];
      if (Math.abs(prev.fs - line.fs) > 0.05 * prev.fs) continue;
      const r = (prev.base - line.base) / prev.fs;
      if (r > 0.9 && r < 2) ratios.push(r);
    }
  }
  ratios.sort((x, y) => x - y);
  return ratios.length ? ratios[ratios.length >> 1] : 1.2;
}

function groupBlocks(lines, ratio) {
  const blocks = [];
  for (const line of lines) {
    // Look a few blocks back so stray items (a footnote mark, a header) in the
    // content stream don't break a paragraph in two.
    let target = null;
    for (let k = blocks.length - 1; k >= 0 && k >= blocks.length - 3 && !target; k--) {
      if (continuesBlock(blocks[k], line, ratio)) target = blocks[k];
    }
    if (target) {
      target.lines.push(line);
      target.x0 = Math.min(target.x0, line.x0);
      target.x1 = Math.max(target.x1, line.x1);
      target.top = Math.max(target.top, line.top);
      target.bottom = Math.min(target.bottom, line.bottom);
    } else {
      blocks.push({ lines: [line], x0: line.x0, x1: line.x1, top: line.top, bottom: line.bottom });
    }
  }
  return blocks;
}

function continuesBlock(block, line, ratio) {
  const prev = block.lines[block.lines.length - 1];
  const fs = Math.max(prev.fs, line.fs);
  const dy = prev.base - line.base;
  // A centred line (the next line of a title, heading or caption) moves both ends
  // by the same amount. Small caps can make its size differ, so it is checked first.
  const centred = Math.abs(line.x0 - prev.x0) > Math.min(prev.fs, line.fs) &&
    Math.abs(line.x0 - prev.x0 + line.x1 - prev.x1) < 0.5 * fs;
  if (centred && Math.min(prev.fs, line.fs) > 0.75 * fs && dy > 0.5 * fs && dy < ratio * fs * 1.3) return true;
  if (Math.abs(prev.fs - line.fs) > 0.12 * fs || line.mark) return false;
  if (Math.abs(dy) < 0.3 * fs) {
    // The same visual line, split at an unusually wide space.
    const gap = line.x0 - prev.x1;
    return gap > -0.5 * fs && gap < 2 * fs;
  }
  if (dy < 0.5 * fs || dy > ratio * fs * 1.3) return false;
  const overlap = Math.min(block.x1, line.x1) - Math.max(block.x0, line.x0);
  if (overlap < 0.5 * Math.min(block.x1 - block.x0, line.x1 - line.x0)) return false;

  // Same column, normal spacing: still a new paragraph if the layout says so.
  const ended = TERMINAL.test(prev.text);
  const many = block.lines.length >= 2;
  const margin = many ? Math.min(...block.lines.slice(1).map(l => l.x0)) : prev.x0;
  if (many && line.x0 < margin - 0.6 * fs) return false; // outdented: next list item
  if (ended && line.x0 > margin + 0.6 * fs && line.x0 < margin + 6 * fs) return false; // indented first line
  if (ended && many && prev.x1 < block.x1 - 2 * fs) return false; // previous line stopped short
  // A line in another font (bold) right above the text is a heading, if it is
  // short or numbered like one.
  const headingLike = prev.x1 < line.x1 - 2 * fs || NUMBERED_HEADING.test(prev.text) || NAMED_HEADING.test(prev.text);
  if (!many && !ended && prev.font !== line.font && headingLike) return false;
  return true;
}

function finishBlock(block, page, view) {
  return {
    ...block,
    page,
    view,
    text: joinText(block.lines.map(l => l.text)),
    plain: joinText(block.lines.map(l => l.plain)), // without the script marks
    fs: dominant(block.lines.map(l => [l.fs, l.text.length])),
  };
}

/** Joins lines into running text, undoing end-of-line hyphenation. */
function joinText(parts) {
  let out = '';
  for (const part of parts) {
    const hyphen = out.match(/(\S+)-$/);
    if (!out) out = part;
    else if (hyphen && /^\p{Ll}/u.test(part) && /\p{L}$/u.test(hyphen[1])) {
      // "representa-" + "tion" joins up; "state-of-" + "the-art" keeps its hyphen.
      out = hyphen[1].includes('-') ? out + part : out.slice(0, -1) + part;
    } else out += ' ' + part;
  }
  return out;
}

/**
 * translatable: worth sending to the model.
 * regular: running text that may continue in, or be continued by, another block.
 * kind: body text and footnotes continue separately.
 * role: heading, caption, list or body, which the translation should respect.
 */
function classify(block, bodyFs) {
  const text = block.text;
  const single = block.lines.length === 1;
  const caption = CAPTION.test(text) || CAPS_TABLE_CAPTION.test(text);
  // Running text is mostly lowercase words and fills its lines. Tables, figure
  // labels, formulas and author lists don't, and neither do URLs and e-mail addresses.
  const words = (text.replace(/\S*(@|:\/\/)\S*/g, '').match(/\p{L}{2,}/gu) || []);
  const lower = words.filter(w => /^\p{Ll}+$/u.test(w)).length;
  const fragment = single && words.length <= 4 && !TERMINAL.test(text);
  // Pseudo-code: most lines end like code ("do", "then", ";"), or a short line of operators.
  const codeLines = block.lines.filter(l => /(;|\{|\}|\bdo|\bthen)$/.test(l.plain)).length;
  const code = block.lines.length >= 3
    ? codeLines >= block.lines.length * 0.4
    : codeLines === block.lines.length || (/[=;{}]|&&|\|\|/.test(block.plain) && !TERMINAL.test(block.plain));
  const prose = !code && lower >= 3 && lower >= words.length * 0.4 && words.length >= block.lines.length * 3.5 && !fragment;
  const short = block.lines.length <= 3 && text.length <= 150; // a heading can wrap onto a second line
  const heading = short && !code && words.length > 0 && (NUMBERED_HEADING.test(text) || NAMED_HEADING.test(text));

  const [, y0, , y1] = block.view;
  const margin = (y1 - y0) * 0.08;
  const edge = single && (block.top > y1 - margin || block.bottom < y0 + margin);
  return {
    translatable: heading || caption || prose,
    regular: prose && !caption && !edge,
    kind: block.fs < bodyFs * 0.92 ? 'small' : 'body',
    role: heading ? 'heading' : caption ? 'caption' : LIST_ITEM.test(text) ? 'list' : 'body',
  };
}

function continuesParagraph(para, block) {
  if (Math.abs(block.fs - para.fs) > 0.1 * para.fs) return false;
  if (/^\p{Ll}/u.test(block.plain)) return true;
  // A hyphenated word only goes on with a lowercase fragment, handled above.
  const lastWord = para.text.match(/([\p{L}-]+)\W*$/u)?.[1]?.toLowerCase();
  return /,$/.test(para.text) || FUNCTION_WORDS.has(lastWord);
}

function endsReferences(block, bodyFs) {
  return block.lines.length === 1 && (APPENDIX_HEADING.test(block.text) || block.fs > bodyFs * 1.1);
}

/**
 * Groups the lines of every page into paragraphs, joining paragraphs that run
 * across columns or pages and leaving out the reference list.
 *
 * @param {{lines: object[], view: number[]}[]} pages - pageLines() output and page.view, per page
 * @returns {{title: string, paragraphs: {id: string, page: number, text: string, role: string,
 *   rects: {page: number, x0: number, y0: number, x1: number, y1: number}[]}[]}}
 */
export function buildParagraphs(pages, { debug = false } = {}) {
  const ratio = leadingRatio(pages);
  const blocks = pages.flatMap(({ lines, view }, page) =>
    groupBlocks(lines, ratio).map(b => finishBlock(b, page, view)));
  if (!blocks.length) return { title: '', paragraphs: [] };
  const bodyFs = dominant(blocks.map(b => [b.fs, b.text.length]));
  const firstPage = blocks.filter(b => b.page === 0 && b.text.length > 10);
  const titleBlock = firstPage.length ? firstPage.reduce((a, b) => (b.fs > a.fs ? b : a)) : null;

  // Text printed on three or more pages (download notices, running headers) is boilerplate.
  const boilerplateKey = b => b.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const pagesWith = new Map();
  for (const b of blocks) {
    const key = boilerplateKey(b);
    pagesWith.set(key, (pagesWith.get(key) || new Set()).add(b.page));
  }
  const boilerplate = b => pagesWith.get(boilerplateKey(b)).size >= 3;

  const paras = [];
  // Per kind, a paragraph that stopped mid-sentence and may go on in a later block.
  const open = { body: null, small: null };
  let inReferences = false;
  for (const block of blocks) {
    if (inReferences && endsReferences(block, bodyFs)) inReferences = false;
    const info = block === titleBlock ? { translatable: true, regular: false, kind: 'body', role: 'title' }
      : boilerplate(block) ? { translatable: false, regular: false, kind: 'body' }
      : classify(block, bodyFs);
    const { translatable, regular, kind, role } = info;
    if (debug) block.info = { ...info, inReferences };
    if (!inReferences && translatable) {
      const pending = regular && open[kind];
      if (pending && continuesParagraph(pending, block)) {
        pending.blocks.push(block);
        pending.text = joinText([pending.text, block.text]);
        if (TERMINAL.test(pending.text)) open[kind] = null;
      } else {
        const para = { blocks: [block], text: block.text, fs: block.fs, role };
        paras.push(para);
        if (regular) open[kind] = TERMINAL.test(para.text) ? null : para;
      }
    }
    if (REFERENCES_HEADING.test(block.text)) inReferences = true;
  }

  return {
    title: titleBlock ? titleBlock.text : '',
    ...(debug && { blocks }),
    paragraphs: paras.map((p, i) => ({
      id: `p${i + 1}`,
      page: p.blocks[0].page,
      text: p.text,
      role: p.role, // title, heading, caption, list or body
      rects: p.blocks.map(b => ({ page: b.page, x0: b.x0, y0: b.bottom, x1: b.x1, y1: b.top })),
    })),
  };
}

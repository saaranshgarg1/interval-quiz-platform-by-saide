import katex from 'katex';

/**
 * LaTeX support for question text and options.
 *
 * `renderRichHtml` turns what an instructor typed into safe HTML:
 *   - math: $…$, $$…$$, \(…\), \[…\]            → KaTeX (real typesetting)
 *   - text: \textbf \textit \emph \texttt \underline \textsc
 *   - lists: \begin{enumerate}[label=(\alph*)] / itemize with \item
 *   - escapes and typography: \% \& \# \_ \$ \{ \}, ~, \\, --, ---, ``…'', \ldots
 *   - the old Markdown shorthands still work: **bold**, *italic*, `code`
 * Everything that is not one of those is HTML-escaped first, and KaTeX runs
 * with trust disabled, so typed text can never inject markup.
 *
 * `parseLatexQuestion` reads a pasted LaTeX question (e.g. from an exam .tex
 * file) into question text + options + the correct choice when it is marked.
 */

// ---------------------------------------------------------------- helpers

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Remove % comments (but not \%). */
function stripComments(src: string): string {
  return src.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** Index of the brace that closes the one at `open` (which must be '{'), or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Replace \cmd{arg} (balanced braces, nested allowed) using `wrap`. */
function replaceCommand(s: string, cmd: string, wrap: (inner: string) => string): string {
  const needle = `\\${cmd}{`;
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf(needle, i);
    if (at === -1) return out + s.slice(i);
    const open = at + needle.length - 1;
    const close = matchBrace(s, open);
    if (close === -1) return out + s.slice(i);
    out += s.slice(i, at) + wrap(replaceCommand(s.slice(open + 1, close), cmd, wrap));
    i = close + 1;
  }
}

// ------------------------------------------------------------------ math

const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;

function renderMath(tex: string, display: boolean): string {
  return katex.renderToString(tex.trim(), {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    output: 'htmlAndMathml',
  });
}

// ----------------------------------------------------------------- lists

const COUNTERS: Record<string, (n: number) => string> = {
  alph: (n) => String.fromCharCode(96 + n),
  Alph: (n) => String.fromCharCode(64 + n),
  arabic: (n) => String(n),
  roman: (n) => toRoman(n).toLowerCase(),
  Roman: (n) => toRoman(n),
};

function toRoman(n: number): string {
  const map: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, r] of map) while (n >= v) { out += r; n -= v; }
  return out;
}

/** "(\alph*)" → n => "(a)"; also accepts enumerate's short form "(a)". */
function labelMaker(spec: string | undefined, kind: 'enumerate' | 'itemize'): (n: number) => string {
  if (kind === 'itemize') return () => '•';
  if (!spec) return (n) => `${n}.`;
  const m = /label\s*=\s*([^,\]]+)/.exec(spec);
  const tpl = (m ? m[1] : spec).trim();
  const counter = /\\(alph|Alph|arabic|roman|Roman)\*/.exec(tpl);
  if (counter) return (n) => tpl.replace(counter[0], COUNTERS[counter[1]](n));
  const short = /^(\W*)([aAiI1])(\W*)$/.exec(tpl); // enumerate package: [(a)], [i.], [A)]
  if (short) {
    const f = { a: COUNTERS.alph, A: COUNTERS.Alph, i: COUNTERS.roman, I: COUNTERS.Roman, '1': COUNTERS.arabic }[short[2]]!;
    return (n) => `${short[1]}${f(n)}${short[3]}`;
  }
  return (n) => `${n}.`;
}

/** Split a list body on \item / \choice / \CorrectChoice at depth 0. */
function splitItems(body: string): { text: string; correct: boolean }[] {
  const items: { text: string; correct: boolean }[] = [];
  const re = /\\(item|choice|CorrectChoice)\b(\s*\[[^\]]*\])?/g;
  let last: { start: number; correct: boolean } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (last) items.push({ text: body.slice(last.start, m.index), correct: last.correct });
    last = { start: m.index + m[0].length, correct: m[1] === 'CorrectChoice' };
  }
  if (last) items.push({ text: body.slice(last.start), correct: last.correct });
  return items;
}

const LIST_ENVS = 'enumerate|itemize|choices|oneparchoices|checkboxes|oneparcheckboxes';
/** Innermost list environment (no nested \begin of a list inside). */
const INNER_LIST = new RegExp(
  String.raw`\\begin\{(${LIST_ENVS})\}(\[[^\]]*\])?((?:(?!\\begin\{(?:${LIST_ENVS})\})[\s\S])*?)\\end\{\1\}`,
);

function renderLists(s: string): string {
  for (let guard = 0; guard < 50; guard++) {
    const m = INNER_LIST.exec(s);
    if (!m) break;
    const kind = m[1] === 'itemize' ? 'itemize' : 'enumerate';
    const label = labelMaker(m[2]?.slice(1, -1), kind);
    const items = splitItems(m[3]).filter((it) => it.text.trim() !== '');
    const html =
      `<ul class="latex-list">` +
      items.map((it, i) => `<li><span class="latex-label">${escapeHtml(label(i + 1))}</span><span>${it.text.trim()}</span></li>`).join('') +
      `</ul>`;
    s = s.slice(0, m.index) + html + s.slice(m.index + m[0].length);
  }
  return s;
}

// ------------------------------------------------------------- rendering

/** Text-mode LaTeX + Markdown on an already HTML-escaped string. */
function renderText(s: string): string {
  // A pasted question often starts with its own "\item" / "\question" marker.
  s = s.replace(/^\s*\\(item|question)\b(\s*\[[^\]]*\])?\s*/, '');
  s = renderLists(s);
  const wrappers: [string, (x: string) => string][] = [
    ['textbf', (x) => `<strong>${x}</strong>`],
    ['textit', (x) => `<em>${x}</em>`],
    ['emph', (x) => `<em>${x}</em>`],
    ['textsl', (x) => `<em>${x}</em>`],
    ['texttt', (x) => `<code>${x}</code>`],
    ['underline', (x) => `<u>${x}</u>`],
    ['textsc', (x) => `<span style="font-variant:small-caps">${x}</span>`],
    ['textrm', (x) => x],
    ['text', (x) => x],
  ];
  for (const [cmd, wrap] of wrappers) s = replaceCommand(s, cmd, wrap);
  s = s
    .replace(/\\(ldots|dots)\b(\{\})?/g, '…')
    .replace(/\\LaTeX\b(\{\})?/g, 'LaTeX')
    .replace(/\\TeX\b(\{\})?/g, 'TeX')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/\\\\(\[[^\]]*\])?|\\newline\b/g, '\n')
    .replace(/\\par\b/g, '\n\n')
    .replace(/\\([%&#_${}])/g, '$1')
    .replace(/(^|[^\\])~/g, '$1&nbsp;')
    .replace(/\\(noindent|centering|medskip|smallskip|bigskip)\b/g, '');
  // Markdown shorthands kept for questions written before LaTeX support.
  s = s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  // Newlines → <br>, but not around the list blocks we produced.
  return s
    .trim()
    .replace(/\s*(<\/?ul[^>]*>|<\/?li>)\s*/g, '$1')
    .replace(/\n/g, '<br>');
}

export function renderRichHtml(content: string): string {
  if (!content) return '';
  const src = stripComments(content);
  const math: string[] = [];
  // Pull math out first so text rules never touch it; placeholders survive escaping.
  const withSlots = src.replace(MATH, (_all, dbl, brk, par, inl) => {
    const display = dbl !== undefined || brk !== undefined;
    math.push(renderMath(dbl ?? brk ?? par ?? inl, display));
    return `\u0000${math.length - 1}\u0000`;
  });
  return renderText(escapeHtml(withSlots)).replace(/\u0000(\d+)\u0000/g, (_m, i) => math[Number(i)]);
}

/**
 * One-line readable text for previews and tooltips (tables, lists):
 * "\textbf{Belady's} $n^2$ **x**" → "Belady's n^2 x". Not for display of the full question.
 */
export function plainText(content: string): string {
  let s = stripComments(content ?? '');
  s = s.replace(/^\s*\\(item|question)\b(\s*\[[^\]]*\])?\s*/, '');
  s = s.replace(/\\begin\{[a-zA-Z*]+\}(\[[^\]]*\])?|\\end\{[a-zA-Z*]+\}/g, ' ');
  s = s.replace(/\\(item|choice|CorrectChoice)\b/g, ' · ');
  for (const cmd of ['textbf', 'textit', 'emph', 'textsl', 'texttt', 'underline', 'textsc', 'textrm', 'text', 'mathrm', 'mathbf']) {
    s = replaceCommand(s, cmd, (x) => x);
  }
  s = s
    .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g, (_m, a, b, c) => ` ${a ?? b ?? c} `)
    .replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, '$1')
    .replace(/\\([%&#_${}])/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\\\|~/g, ' ')
    .replace(/\s+/g, ' ');
  return s.trim();
}

/** Does this text use LaTeX (so the editor can show a hint / preview)? */
export function looksLikeLatex(s: string): boolean {
  return /\\[a-zA-Z]+|\$[^$]+\$/.test(s);
}

// --------------------------------------------------------- paste import

export interface ParsedLatexQuestion {
  text: string;
  options: string[];
  /** Indexes of options marked correct (\CorrectChoice or \correct), if any. */
  correct: number[];
  /** More than one question was found; only the first is returned. */
  more: number;
}

/**
 * Read a LaTeX question such as
 *   \item Which … \textbf{Belady's Anomaly}?
 *   \begin{enumerate}[label=(\alph*)] \item LRU \item FIFO \correct … \end{enumerate}
 * Also understands the exam class (\question, \begin{choices}, \choice, \CorrectChoice).
 */
export function parseLatexQuestion(src: string): ParsedLatexQuestion | null {
  // Mark "% correct" comments before comments are stripped.
  let s = src.replace(/%\s*(correct|answer|ans)\b.*$/gim, ' \\correct ');
  s = stripComments(s).trim();
  // Unwrap an outer list of questions, e.g. \begin{enumerate} \item Q1 … \item Q2 … \end{enumerate}.
  const outer = new RegExp(String.raw`^\\begin\{(enumerate|questions)\}(\[[^\]]*\])?([\s\S]*)\\end\{\1\}\s*$`).exec(s);
  if (outer) s = outer[3].trim();

  const questions = splitTopLevelQuestions(s);
  if (questions.length === 0) return null;
  const first = questions[0];
  const list = new RegExp(String.raw`\\begin\{(${LIST_ENVS})\}(\[[^\]]*\])?([\s\S]*?)\\end\{\1\}`).exec(first);

  const textPart = (list ? first.slice(0, list.index) + first.slice(list.index + list[0].length) : first)
    .replace(/^\s*\\(item|question)\b(\s*\[[^\]]*\])?\s*/, '')
    .trim();
  const items = list ? splitItems(list[3]).filter((it) => it.text.trim() !== '') : [];
  const correct: number[] = [];
  const options = items.map((it, i) => {
    let t = it.text.trim();
    if (it.correct || /\\correct\b/.test(t)) correct.push(i);
    t = t.replace(/\s*\\correct\b\s*/g, ' ').trim();
    return t;
  });
  return { text: textPart, options, correct, more: questions.length - 1 };
}

/** Split on top-level \item / \question (not the ones inside an option list). */
function splitTopLevelQuestions(s: string): string[] {
  const starts: number[] = [];
  let depth = 0;
  const re = new RegExp(String.raw`\\begin\{(?:${LIST_ENVS})\}|\\end\{(?:${LIST_ENVS})\}|\\(?:item|question)\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[0].startsWith('\\begin')) depth++;
    else if (m[0].startsWith('\\end')) depth--;
    else if (depth === 0) starts.push(m.index);
  }
  if (starts.length === 0) return s.trim() ? [s] : [];
  if (s.slice(0, starts[0]).trim()) starts.unshift(0); // text before the first \item
  return starts.map((st, i) => s.slice(st, starts[i + 1] ?? s.length).trim()).filter(Boolean);
}

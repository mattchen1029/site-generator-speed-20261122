// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// A from-scratch reimplementation of makefun-site's build with identical output
// and far less work: run-copying HTML escaping, a fused Markdown lexer/renderer,
// an ASCII fast path for slugs, and templates compiled to plain JS functions.
// Pure JS/TS only: no WASM, no native code, no dependencies.

/* ------------------------------------------------------------------ text */

// The HTML escape table, in this order: & < > " ' (same as makefun-site).
const ESC_MAP = new Array(128);
ESC_MAP[34] = '&quot;';
ESC_MAP[38] = '&amp;';
ESC_MAP[39] = '&#39;';
ESC_MAP[60] = '&lt;';
ESC_MAP[62] = '&gt;';

/** `text` with & < > " and ' escaped. Returns the input unchanged when it holds none. */
export function escapeHtml(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const e = c < 128 ? ESC_MAP[c] : undefined;
    if (e !== undefined) {
      if (i > start) out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  if (start === 0) return text;
  if (start < text.length) out += text.slice(start);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/** The slug of `text`, exactly as makefun-site's slugify (NFKD, marks dropped, A-Z lowered,
 *  each run of other characters one "-", none at either end, at most 64 chars, "untitled" when empty).
 *  Pure-ASCII input takes a fast path: NFKD is the identity there and there are no combining marks. */
export function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is a whitespace character, as the \s class has it (no unicode flag). */
function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xA0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F ||
    c === 0x3000 || c === 0xFEFF;
}

/** The words of a body: its runs of characters other than whitespace (the same count as /\S+/g). */
export function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { count++; inWord = true; }
  }
  return count;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/* ------------------------------------------------------------ front matter */

// The keys a source's front matter may give.
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a template name (a-z, 0-9 and -). */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single - between), at most 64 characters. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (alnum) { prevDash = false; continue; }
    if (c === 45) {
      if (i === 0 || prevDash) return false;
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  if (firstLine !== '---') return { error: 'no front matter' };
  // Find the closing "---" line.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = firstNL === -1 ? text.length : firstNL + 1;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  let p = firstNL === -1 ? text.length : firstNL + 1;
  while (p < closeStart) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(p, lineEnd);
    lineNo++;
    // Blank (spaces and tabs only) or a comment (opening on #): skipped.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // key: value — key of a-z and _, a colon, one space and the value.
      let i = 0;
      while (i < line.length) {
        const c = line.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        i++;
      }
      if (i === 0 || i >= line.length || line.charCodeAt(i) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, i);
      let raw;
      if (i + 1 === line.length) raw = '';
      else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      // Trailing spaces and tabs dropped.
      let end = raw.length;
      while (end > 0) {
        const c = raw.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      if (end !== raw.length) raw = raw.slice(0, end);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd + 1) };
}

/* ----------------------------------------------------------------- Markdown */

// Line kinds.
const K_BLANK = 0;
const K_FENCE = 1;
const K_HEADING = 2;
const K_HR = 3;
const K_QUOTE = 4;
const K_BULLET = 5;
const K_ORDERED = 6;
const K_TEXT = 7;

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` is a closing fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isWSCode(line.charCodeAt(i));
}

/**
 * Classify one line, writing its kind and (for headings and list lines) its data into the
 * parallel arrays. Mirrors the reference lexer's checks, in the same order:
 * blank, fence open, heading, thematic break, blockquote, bullet / ordered, else text.
 */
function classifyLine(line, i, kinds, headDepth, headText, itemText, itemStart, fenceLang) {
  const n = line.length;
  if (n === 0) { kinds[i] = K_BLANK; return; }
  const c0 = line.charCodeAt(0);
  // Blank: spaces and tabs only.
  if (c0 === 32 || c0 === 9) {
    let blank = true;
    for (let j = 1; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank) { kinds[i] = K_BLANK; return; }
  }
  // Fence open: three backticks and an optional language (A-Z, a-z, 0-9, _, +, -), then spaces/tabs only.
  if (c0 === 96 && n >= 3 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
    let j = 3;
    while (j < n) {
      const c = line.charCodeAt(j);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
      j++;
    }
    let ok = true;
    for (let k = j; k < n; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { ok = false; break; }
    }
    if (ok) {
      kinds[i] = K_FENCE;
      fenceLang[i] = line.slice(3, j);
      return;
    }
  }
  // Heading: 1 to 6 #, at least one space or tab, then text (spaces/tabs at its end dropped).
  if (c0 === 35) {
    let j = 1;
    while (j < n && j < 6 && line.charCodeAt(j) === 35) j++;
    const depth = j;
    if (j < n && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) {
      let a = j;
      while (a < n && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
      let b = n;
      while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
      if (b > a) {
        kinds[i] = K_HEADING;
        headDepth[i] = depth;
        headText[i] = line.slice(a, b);
        return;
      }
    }
  }
  // Thematic break: --- or ***, then spaces or tabs only.
  if ((c0 === 45 || c0 === 42) && n >= 3 && line.charCodeAt(1) === c0 && line.charCodeAt(2) === c0) {
    let ok = true;
    for (let j = 3; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { ok = false; break; }
    }
    if (ok) { kinds[i] = K_HR; return; }
  }
  // Blockquote: a line opening on >.
  if (c0 === 62) { kinds[i] = K_QUOTE; return; }
  // Bullet list: - or * followed by a space.
  if ((c0 === 45 || c0 === 42) && n >= 2 && line.charCodeAt(1) === 32) {
    kinds[i] = K_BULLET;
    itemText[i] = trimLine(line.slice(2));
    return;
  }
  // Ordered list: 1 to 9 digits, ". ", then text.
  if (c0 >= 48 && c0 <= 57) {
    let j = 1;
    while (j < n && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j < n && line.charCodeAt(j) === 46 && j + 1 < n && line.charCodeAt(j + 1) === 32) {
      kinds[i] = K_ORDERED;
      itemStart[i] = Number(line.slice(0, j));
      itemText[i] = trimLine(line.slice(j + 2));
      return;
    }
  }
  kinds[i] = K_TEXT;
}

/** Whether a line (by kind) ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(kind) {
  return kind === K_BLANK || kind === K_FENCE || kind === K_HEADING || kind === K_HR;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs are copied out whole
 * (escaped once) instead of escaping character by character.
 */
export function inline(s, env) {
  const out = [];
  const n = s.length;
  let i = 0;
  let seg = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > seg) out.push(escapeHtml(s.slice(seg, i)));
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > seg) out.push(escapeHtml(s.slice(seg, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > seg) out.push(escapeHtml(s.slice(seg, i)));
          out.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2;
          seg = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > seg) out.push(escapeHtml(s.slice(seg, i)));
        out.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > seg) out.push(escapeHtml(s.slice(seg, i)));
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  if (n > seg) out.push(escapeHtml(s.slice(seg, n)));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). Lexing and rendering run in one pass over the lines.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const kinds = new Uint8Array(n);
  const headDepth = new Uint8Array(n);
  const headText = new Array(n);
  const itemText = new Array(n);
  const itemStart = new Float64Array(n);
  const fenceLang = new Array(n);
  for (let i = 0; i < n; i++) classifyLine(lines[i], i, kinds, headDepth, headText, itemText, itemStart, fenceLang);

  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const k = kinds[i];
    if (k === K_BLANK) { i++; continue; }
    if (k === K_FENCE) {
      const lang = fenceLang[i];
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (let b = 0; b < body.length; b++) code += escapeHtml(body[b]) + '\n';
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    if (k === K_HEADING) {
      const depth = headDepth[i];
      const text = headText[i];
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, env);
      blocks.push(`<h${depth} id="${id}">${html}</h${depth}>`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (k === K_HR) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (k === K_QUOTE) {
      const body = [];
      while (i < n && kinds[i] === K_QUOTE) {
        const line = lines[i++];
        const stripped = line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1);
        const t = trimLine(stripped);
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (k === K_BULLET || k === K_ORDERED) {
      const isOrdered = k === K_ORDERED;
      const start = isOrdered ? itemStart[i] : 1;
      const items = [];
      while (i < n) {
        const kk = kinds[i];
        if ((isOrdered && kk === K_ORDERED) || (!isOrdered && kk === K_BULLET)) {
          items.push([itemText[i]]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (let it = 0; it < items.length; it++) inner += `<li>${inline(items[it].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    const body = [trimLine(lines[i])];
    i++;
    while (i < n && !endsParagraph(kinds[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

// The deepest an include nests: one past it renders nothing.
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template into a plain JS function (S, C, D) => string: S is the scope chain
 * ({vars, parent}), C holds the escape and the compiled templates, D is the include depth.
 * Loop frames are created once per loop and reused across iterations (rendering is synchronous,
 * so nothing can observe the reuse), which keeps the garbage collector quiet.
 */
const compileFactory = new Function('lk', 'ty', 'tx', 'ID', `
  return function compile(src, name) {
    const paths = [];
    const pathId = (p) => {
      for (let i = 0; i < paths.length; i++) if (paths[i].length === p.length && paths[i].every((x, k) => x === p[k])) return i;
      paths.push(p);
      return paths.length - 1;
    };
    let uid = 0;
    const gen = (nodes, sv) => {
      let code = '';
      for (const n of nodes) {
        if (n.kind === 'text') code += 'out.push(' + JSON.stringify(n.text) + ');';
        else if (n.kind === 'var') code += 'out.push(C.esc(tx(lk(' + sv + ',p' + pathId(n.path) + '))));';
        else if (n.kind === 'raw') code += 'out.push(tx(lk(' + sv + ',p' + pathId(n.path) + ')));';
        else if (n.kind === 'if') {
          code += 'if(ty(lk(' + sv + ',p' + pathId(n.path) + '))!==' + (n.not ? 'true' : 'false') + '){' + gen(n.then, sv) + '}';
          if (n.else !== null) code += 'else{' + gen(n.else, sv) + '}';
        } else if (n.kind === 'for') {
          const f = 'f' + (uid++);
          const s = 's' + (uid++);
          const v = 'v' + (uid++);
          const k = 'k' + (uid++);
          code += '{const ' + v + '=lk(' + sv + ',p' + pathId(n.path) + ');if(Array.isArray(' + v + ')){'
            + 'const ' + f + '={vars:{' + JSON.stringify(n.name) + ':null,loop:{index:0,first:false,last:false,length:' + v + '.length}},parent:' + sv + '};'
            + 'const ' + s + '=' + f + '.vars;const L=' + f + '.vars.loop;'
            + 'for(let ' + k + '=0;' + k + '<' + v + '.length;' + k + '++){'
            + (n.name === 'loop' ? '' : s + '[' + JSON.stringify(n.name) + ']=' + v + '[' + k + '];')
            + 'L.index=' + k + '+1;L.first=' + k + '===0;L.last=' + k + '===' + v + '.length-1;'
            + gen(n.body, f)
            + '}}}';
        } else if (n.kind === 'include') {
          code += 'if(D<' + ID + '){const t=C.tpl.get(' + JSON.stringify(n.name) + ');if(t!==undefined)out.push(t(' + sv + ',C,D+1));}';
        }
      }
      return code;
    };
    const body = gen(src, 'S');
    const decls = paths.map((p, i) => 'p' + i + '=' + JSON.stringify(p)).join(',');
    const fn = new Function('lk', 'ty', 'tx', 'return function(S,C,D){const out=[];' + (decls ? 'const ' + decls + ';' : '') + body + 'return out.join("");}')(lk, ty, tx);
    return fn;
  };
`);

const compileTemplate = compileFactory(lookup, truthy, textOf, INCLUDE_DEPTH);

/* -------------------------------------------------------------------- build */

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const slugCache = new Map();
  const slugOf = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) { v = slugify(text); slugCache.set(text, v); }
    return v;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenSet = taken.get(dir);
    if (takenSet === undefined) {
      takenSet = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, takenSet);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenSet);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        // A target with a scheme, opening on / or opening on # is kept as written.
        const ci = target.indexOf(':');
        if (ci > 0) {
          const c0 = target.charCodeAt(0);
          if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
            let scheme = true;
            for (let i = 1; i < ci; i++) {
              const c = target.charCodeAt(i);
              if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) { scheme = false; break; }
            }
            if (scheme) return target;
          }
        }
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugOf(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // Compile each template once; a page renders through its layout in a scope of the page's values
  // over the shared site / tags / recent values.
  const compiled = new Map();
  for (const [name, nodes] of b.templates) compiled.set(name, compileTemplate(nodes, name));
  const ctx = { tpl: compiled, esc: escapeHtml };

  // A post's card, as lists show it (computed once per source).
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });

  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => cardOf(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    return fn({ vars, parent: rootScope }, ctx, 0);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}

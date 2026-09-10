// TOON (Token-Oriented Object Notation) parser and serializer.
// Targets toon-spec 4.1 (https://github.com/toon-format/spec/blob/main/SPEC.md).
// Section references in comments (e.g. "7.2") point at that document.
//
// Two channels, by design:
//   parse(text)          -> a plain JS value. Comments and spelling are dropped.
//   parseLossless(text)  -> a ToonDocument: the same value plus a `layout` side
//                           table that lets serialize() reproduce the source
//                           byte-for-byte, including comments and blank lines.
// A plain JS value cannot carry comments, blank lines, or the choice between
// two legal spellings of the same value, so the side table is a separate
// Map keyed by JSON Pointer. See the header comment on `parseLossless`.

import { isDeepStrictEqual } from 'node:util';

// Spec 13: indentSize default is 2 spaces.
const DEFAULT_INDENT_SIZE = 2;
// Spec 11: the three delimiters TOON permits. Comma is the default and is the
// only one with no symbol inside the bracket segment.
const COMMA = ',';
const TAB = '\t';
const PIPE = '|';
const DELIMITERS = new Set([COMMA, TAB, PIPE]);

// Spec 4: an unquoted token is a number only if it matches this and carries no
// forbidden leading zero. Deliberately narrower than JS's own Number parser.
const DECODER_NUMBER = /^-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
// Spec 4: "05", "0001", "-05" are strings; "0.5" and "0e1" are numbers.
const FORBIDDEN_LEADING_ZERO = /^-?0[0-9]/;
// Spec 7.2: the encoder-side "numeric-like" test, which also covers a leading "+".
const ENCODER_NUMERIC_LIKE = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
// Spec 7.3: the only key shape an encoder may leave unquoted.
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
// Spec 3: a host string holding an unpaired surrogate is not representable.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class ToonError extends Error {
  constructor(message, { line = null, code = 'toon_error' } = {}) {
    super(message);
    this.name = 'ToonError';
    this.line = line;
    this.code = code;
  }
}

function fail(code, line, message) {
  throw new ToonError(message, { line, code });
}

// --- small value predicates ------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPrimitive = (v) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// --- JSON Pointer (RFC 6901) paths for the layout side table ---------------

function ptr(base, token) {
  return `${base}/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

// ===========================================================================
// Lexical helpers
// ===========================================================================

// Index of the first character of `chars` that lies outside a quoted string,
// or -1. A backslash inside a quoted string escapes the next character, so a
// `\"` never closes the string.
function indexOfUnquoted(s, chars, start = 0) {
  let quoted = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (chars.includes(c)) return i;
  }
  return -1;
}

// Splits on `delim` outside quoted strings, returning the raw (untrimmed) parts.
//
// A double quote only opens a quoted span when it begins a token (spec 7.4:
// only a token whose *first* character is `"` is a quoted token). So `a"b` is
// the ordinary string a"b, per 4's "otherwise -> string" fallback, rather than
// an unterminated string that swallows the rest of the line.
function splitUnquoted(s, delim) {
  const parts = [];
  let quoted = false;
  let atTokenStart = true;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === delim) { parts.push(s.slice(start, i)); start = i + 1; atTokenStart = true; continue; }
    if (c === '"' && atTokenStart) { quoted = true; atTokenStart = false; continue; }
    // Spec 12 trims U+0020 around a token, so a space does not end the run-in.
    if (c !== ' ') atTokenStart = false;
  }
  parts.push(s.slice(start));
  return parts;
}

// End index (exclusive) of a complete quoted token starting at `start`, or -1
// when the string is unterminated.
function quotedTokenEnd(s, start) {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i + 1;
  }
  return -1;
}

// Spec 7.1: unescape a quoted token. `text` includes both delimiting quotes.
function unquote(text, lineNo) {
  let out = '';
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i];
    if (c !== '\\') { out += c; continue; }
    const e = text[i + 1];
    if (e === '\\' || e === '"') { out += e; i++; continue; }
    if (e === 'n') { out += '\n'; i++; continue; }
    if (e === 'r') { out += '\r'; i++; continue; }
    if (e === 't') { out += '\t'; i++; continue; }
    if (e === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        fail('invalid_escape', lineNo, '\\u must be followed by exactly four hex digits');
      }
      const code = parseInt(hex, 16);
      // Spec 7.1: a \uXXXX surrogate is rejected; supplementary characters must
      // arrive as literal UTF-8.
      if (code >= 0xd800 && code <= 0xdfff) {
        fail('lone_surrogate', lineNo, `\\u${hex} is a lone surrogate and is not decodable`);
      }
      out += String.fromCharCode(code);
      i += 5;
      continue;
    }
    fail('invalid_escape', lineNo, `invalid escape sequence \\${e ?? ''} in a quoted token`);
  }
  return out;
}

// Spec 4: type an unquoted value token.
function decodeUnquoted(token) {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  if (DECODER_NUMBER.test(token) && !FORBIDDEN_LEADING_ZERO.test(token)) return Number(token);
  return token;
}

// Spec 12 trims exactly U+0020 around an extracted token; nothing else.
const trimSpaces = (s) => s.replace(/^ +/, '').replace(/ +$/, '');

// Decodes one value token. `raw` may carry the surrounding U+0020 padding.
function decodeToken(raw, lineNo) {
  const token = trimSpaces(raw);
  if (token.startsWith('"')) {
    const end = quotedTokenEnd(token, 0);
    if (end === -1) fail('unterminated_string', lineNo, 'unterminated quoted string');
    // Spec 7.4: the closing quote must be the token's last character.
    if (end !== token.length) {
      fail('trailing_after_quote', lineNo, 'unexpected content after a quoted token');
    }
    return unquote(token, lineNo);
  }
  // Spec 7.4: a `"` that does not begin the token has no structural meaning,
  // so the token decodes per 4 like any other unquoted token.
  return decodeUnquoted(token);
}

// Decodes a key token (quoted or unquoted). Spec 7.4: decoders accept any
// unquoted token as a literal key.
function decodeKeyToken(raw, lineNo) {
  const token = trimSpaces(raw);
  if (token.startsWith('"')) {
    const end = quotedTokenEnd(token, 0);
    if (end === -1) fail('unterminated_string', lineNo, 'unterminated quoted key');
    if (end !== token.length) {
      fail('trailing_after_quote', lineNo, 'unexpected content after a quoted key');
    }
    return unquote(token, lineNo);
  }
  return token;
}

// ===========================================================================
// Header parsing (spec 6)
// ===========================================================================

// Parses a field list body (the text between the outer braces) into a tree of
// { name, children }. Spec 6: the delimiter inside a nested group is the same
// active delimiter as the enclosing header.
function parseFieldList(body, delim, lineNo) {
  if (body === '') fail('empty_field_list', lineNo, 'an empty field list {} is not a valid header');
  const entries = [];
  let depth = 0;
  let quoted = false;
  let atTokenStart = true;
  let start = 0;
  const cuts = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    // As in splitUnquoted: a quote only delimits when it begins a field name.
    if (c === '"' && atTokenStart) { quoted = true; atTokenStart = false; continue; }
    if (c !== ' ') atTokenStart = false;
    if (c === '{') { depth++; atTokenStart = true; continue; }
    if (c === '}') {
      depth--;
      if (depth < 0) fail('unmatched_brace', lineNo, 'unmatched } in a header field list');
      continue;
    }
    if (depth === 0 && c === delim) {
      cuts.push(body.slice(start, i));
      start = i + 1;
      atTokenStart = true;
    }
  }
  if (quoted) fail('unterminated_string', lineNo, 'unterminated quoted field name');
  if (depth !== 0) fail('unmatched_brace', lineNo, 'unmatched { in a header field list');
  cuts.push(body.slice(start));

  for (const part of cuts) {
    const open = indexOfUnquoted(part, '{');
    if (open === -1) {
      entries.push({ name: decodeKeyToken(part, lineNo), children: null });
      continue;
    }
    if (!part.endsWith('}')) {
      fail('malformed_field_list', lineNo, `malformed nested field group in "${part}"`);
    }
    entries.push({
      name: decodeKeyToken(part.slice(0, open), lineNo),
      children: parseFieldList(part.slice(open + 1, -1), delim, lineNo),
    });
  }
  if (entries.length === 0) {
    fail('empty_field_list', lineNo, 'an empty field list {} is not a valid header');
  }
  // Spec 14.2: a field name repeated within the same field list is a defect.
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.name)) {
      fail('duplicate_field', lineNo, `field "${e.name}" appears twice in the same field list`);
    }
    seen.add(e.name);
  }
  return entries;
}

function leafNames(tree, out = []) {
  for (const f of tree) {
    if (f.children) leafNames(f.children, out);
    else out.push(f.name);
  }
  return out;
}

// Returns a parsed header, or null when the line is not header-shaped at all.
// Throws in strict mode for lines that are header-shaped but malformed (6, 14.2).
function parseHeader(content, lineNo, strict) {
  const open = indexOfUnquoted(content, '[');
  if (open === -1) return null;
  const colon = indexOfUnquoted(content, ':');
  // Spec 5.2: a line whose first unquoted colon precedes its first unquoted
  // "[" is never a header.
  if (colon !== -1 && colon < open) return null;

  const keyText = content.slice(0, open);
  const notHeader = (code, message) => {
    if (strict) fail(code, lineNo, message);
    return null;
  };

  let key = null;
  let keyRaw = '';
  if (keyText !== '') {
    // Spec 6: whitespace between a key and its bracket segment is an error.
    if (/\s$/.test(keyText)) {
      return notHeader('header_spacing', `whitespace between the key and "[" in "${content}"`);
    }
    if (keyText.startsWith('"')) {
      const end = quotedTokenEnd(keyText, 0);
      if (end !== keyText.length) {
        return notHeader('header_key', `malformed quoted key in "${content}"`);
      }
    }
    keyRaw = keyText;
    key = decodeKeyToken(keyText, lineNo);
  }

  const close = content.indexOf(']', open);
  if (close === -1) return notHeader('malformed_bracket', `unclosed bracket segment in "${content}"`);
  const seg = content.slice(open + 1, close);

  // bracket-seg = "[" length [ delimsym ] "]"  |  "[" length ":" [ delimsym ] "]"
  const m = /^([0-9]+)(:?)([\t|]?)$/.exec(seg);
  if (!m) return notHeader('malformed_bracket', `malformed bracket segment "[${seg}]"`);
  const [, lengthText, keyedMark, delimSym] = m;
  // Spec 6: no leading zeros; "0" is the only spelling of length zero.
  if (lengthText.length > 1 && lengthText[0] === '0') {
    return notHeader('malformed_bracket', `bracket length "${lengthText}" has a leading zero`);
  }
  const length = Number(lengthText);
  const keyed = keyedMark === ':';
  const delim = delimSym === '' ? COMMA : delimSym;

  let rest = content.slice(close + 1);
  let fields = null;
  let fieldsRaw = null;
  if (rest.startsWith('{')) {
    let depth = 0;
    let quoted = false;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return notHeader('unmatched_brace', `unmatched { in "${content}"`);
    fieldsRaw = rest.slice(1, end);
    // Spec 6/14.2: a field list carrying an unquoted delimiter other than the
    // declared one is a header syntax error.
    for (const d of DELIMITERS) {
      if (d !== delim && indexOfUnquoted(fieldsRaw, d) !== -1) {
        return notHeader(
          'delimiter_mismatch',
          `field list uses "${d === TAB ? '\\t' : d}" but the bracket segment declares "${delim === TAB ? '\\t' : delim}"`,
        );
      }
    }
    fields = parseFieldList(fieldsRaw, delim, lineNo);
    rest = rest.slice(end + 1);
  }

  if (!rest.startsWith(':')) {
    return notHeader('missing_colon', `missing ":" after the header in "${content}"`);
  }
  const tail = rest.slice(1);

  // Spec 6: a keyed header MUST carry a field list.
  if (keyed && !fields) {
    return notHeader('keyed_without_fields', `keyed header "${content}" has no field list`);
  }
  // Spec 6/14.2: a fields-bearing header carries no inline content.
  if (fields && trimSpaces(tail) !== '') {
    return notHeader('content_after_header', `unexpected content after a fields-bearing header on "${content}"`);
  }

  return { key, keyRaw, length, delim, keyed, fields, tail, lengthText, delimSym, fieldsRaw };
}

// ===========================================================================
// Line preparation (spec 5.1, 12)
// ===========================================================================

function prepareLines(text, indentSize, strict) {
  // Spec 12: a single leading U+FEFF is a byte-order mark, not content.
  const src = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const finalNewline = src.endsWith('\n');
  const rawLines = src.split('\n');
  if (finalNewline) rawLines.pop();

  const lines = [];
  let pending = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    // Spec 12: a trailing CR belongs to the line terminator, not the content.
    const raw = rawLines[idx].replace(/\r$/, '');
    const lineNo = idx + 1;

    // Spec 5.1: only spaces may precede the "#" of a comment line.
    if (/^ *#/.test(raw)) { pending.push(raw); continue; }
    if (raw.trim() === '') { pending.push(raw); continue; }

    const indent = /^[ \t]*/.exec(raw)[0];
    if (indent.includes('\t')) {
      if (strict) fail('tab_indent', lineNo, 'tabs must not be used for indentation');
    }
    if (strict && indent.length % indentSize !== 0) {
      fail('bad_indent', lineNo, `indentation of ${indent.length} spaces is not a multiple of ${indentSize}`);
    }
    lines.push({
      raw,
      lineNo,
      indent,
      // Spec 12: trailing U+0020 is not part of the line's content.
      content: raw.slice(indent.length).replace(/ +$/, ''),
      depth: Math.floor(indent.length / indentSize),
      before: pending,
      hasBlankBefore: pending.some((l) => l.trim() === ''),
    });
    pending = [];
  }
  return { lines, trailing: pending, finalNewline };
}

// ===========================================================================
// Parser
// ===========================================================================

class Parser {
  constructor(text, opts) {
    this.strict = opts.strict !== false;
    this.indentSize = opts.indentSize ?? DEFAULT_INDENT_SIZE;
    const prep = prepareLines(text, this.indentSize, this.strict);
    this.lines = prep.lines;
    this.trailing = prep.trailing;
    this.finalNewline = prep.finalNewline;
    this.i = 0;
    this.layout = new Map();
  }

  peek() { return this.i < this.lines.length ? this.lines[this.i] : null; }

  record(path, entry) { this.layout.set(path, entry); }

  // A single-line node: the verbatim line reproduces it exactly as long as the
  // value at `path` is still deep-equal to what that line decoded to. The
  // snapshot is cloned, so a caller mutating the parsed value cannot silently
  // mutate the record it is compared against.
  recordSingle(path, line, snapshot) {
    this.record(path, {
      before: line.before,
      line: line.raw,
      snapshot: structuredClone(snapshot),
      single: true,
    });
  }

  recordContainer(path, line, sig, extra = {}) {
    this.record(path, {
      before: line ? line.before : [],
      line: line ? line.raw : null,
      sig,
      single: false,
      ...extra,
    });
  }

  // --- root (spec 5) -------------------------------------------------------

  parseRoot() {
    const first = this.peek();
    if (!first) return {};

    if (first.depth !== 0) {
      fail('bad_indent', first.lineNo, 'the first content line must be at depth 0');
    }

    if (first.content === '[]') {
      this.i++;
      this.recordSingle('', first, []);
      this.checkNoTrailingContent();
      return [];
    }

    const header = parseHeader(first.content, first.lineNo, this.strict);
    if (header && header.key === null) {
      this.i++;
      const value = this.consumeHeaderValue(header, first, 0, '');
      this.checkNoTrailingContent();
      return value;
    }
    if (header && header.key !== null) {
      return this.parseObjectScope(0, '');
    }

    const hasColon = indexOfUnquoted(first.content, ':') !== -1;
    if (!hasColon) {
      // Spec 5: a lone non-blank line that is neither a header nor a key-value
      // line decodes as a root primitive.
      if (this.lines.length === 1) {
        this.i++;
        this.recordSingle('', first, decodeToken(first.content, first.lineNo));
        return decodeToken(first.content, first.lineNo);
      }
      fail('scalar_line', first.lineNo, `"${first.content}" is not a header or a key-value line`);
    }
    return this.parseObjectScope(0, '');
  }

  checkNoTrailingContent() {
    const next = this.peek();
    if (next && this.strict) {
      fail('trailing_content', next.lineNo, 'content after a completed root form');
    }
  }

  // --- objects (spec 8) ----------------------------------------------------

  parseObjectScope(depth, path, into = {}) {
    while (this.i < this.lines.length) {
      const line = this.peek();
      if (line.depth < depth) break;
      if (line.depth > depth) {
        fail('over_indent', line.lineNo, `line is indented deeper than its enclosing scope (depth ${line.depth}, expected ${depth})`);
      }
      if (line.content.startsWith('- ') || line.content === '-') break;
      this.i++;
      this.consumeField(line.content, line, depth, path, into);
    }
    return into;
  }

  // Parses one `key: …` or `key[N…]…:` member. `line` is the source line the
  // text came from; for a field carried on a list-item hyphen line the text is
  // the part after "- " while `depth` is already the spec-10 depth d+1.
  consumeField(content, line, depth, path, into, hyphen = false) {
    const header = parseHeader(content, line.lineNo, this.strict);
    if (header) {
      if (header.key === null) {
        fail('keyless_header', line.lineNo, 'a keyless header is only valid as the document root');
      }
      const childPath = ptr(path, header.key);
      this.assignKey(into, header.key, this.consumeHeaderValue(header, line, depth, childPath, hyphen), line);
      return;
    }
    const colon = indexOfUnquoted(content, ':');
    if (colon === -1) {
      fail('missing_colon', line.lineNo, `"${content}" has no key/value colon`);
    }
    const key = decodeKeyToken(content.slice(0, colon), line.lineNo);
    const childPath = ptr(path, key);
    const rest = content.slice(colon + 1);
    const trimmed = trimSpaces(rest);

    if (trimmed === '') {
      // Spec 8: a bare `key:` opens a nested object, or is an empty object.
      const next = this.peek();
      if (next && next.depth === depth + 1) {
        this.recordContainer(childPath, line, 'nested', { hyphen });
        this.assignKey(into, key, this.parseObjectScope(depth + 1, childPath), line);
      } else if (next && next.depth > depth + 1) {
        fail('depth_jump', next.lineNo, `line jumps from depth ${depth} to depth ${next.depth}`);
      } else {
        this.recordContainer(childPath, line, 'nested', { hyphen });
        this.assignKey(into, key, {}, line);
      }
      return;
    }
    if (trimmed === '[]') {
      this.recordSingle(childPath, line, []);
      if (hyphen) this.layout.get(childPath).hyphen = true;
      this.assignKey(into, key, [], line);
      return;
    }
    const value = decodeToken(rest, line.lineNo);
    this.recordSingle(childPath, line, value);
    if (hyphen) this.layout.get(childPath).hyphen = true;
    this.assignKey(into, key, value, line);
  }

  // Spec 14.3: duplicate sibling keys error in strict mode, last-write-wins
  // otherwise.
  assignKey(obj, key, value, line) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (this.strict) fail('duplicate_key', line.lineNo, `duplicate sibling key "${key}"`);
    }
    obj[key] = value;
  }

  // --- arrays and keyed objects (spec 9) -----------------------------------

  consumeHeaderValue(header, line, depth, path, hyphen = false) {
    if (header.keyed) return this.parseKeyedScope(header, line, depth, path, hyphen);
    if (header.fields) return this.parseTabularScope(header, line, depth, path, hyphen);

    const tail = trimSpaces(header.tail);
    if (tail === '') {
      if (header.length === 0) {
        // Legacy empty-array header form (9.1); still decodes, never emitted.
        this.recordSingle(path, line, []);
        if (hyphen) this.layout.get(path).hyphen = true;
        return [];
      }
      return this.parseListScope(header, line, depth, path, hyphen);
    }
    // Inline primitive array (9.1) - one physical line, so reuse-if-unchanged.
    const cells = splitUnquoted(header.tail, header.delim);
    const values = cells.map((c) => decodeToken(c, line.lineNo));
    if (this.strict && values.length !== header.length) {
      fail('count_mismatch', line.lineNo,
        `inline array declares [${header.length}] but carries ${values.length} values`);
    }
    this.recordSingle(path, line, values);
    this.layout.get(path).sig = `inline|${header.delim}`;
    if (hyphen) this.layout.get(path).hyphen = true;
    return values;
  }

  parseTabularScope(header, line, depth, path, hyphen) {
    const rowDepth = depth + 1;
    const leaves = leafNames(header.fields).length;
    const rows = [];
    this.recordContainer(path, line, sigOf('tabular', header.delim, header.length, header.fields), {
      form: 'tabular',
      delim: header.delim,
      hyphen,
    });
    while (this.i < this.lines.length) {
      const row = this.peek();
      if (row.depth < rowDepth) break;
      if (row.depth > rowDepth) {
        fail('over_indent', row.lineNo, `row is indented deeper than the tabular scope (depth ${row.depth}, expected ${rowDepth})`);
      }
      // Spec 9.3 disambiguation: a colon before the first unquoted delimiter
      // ends the rows.
      const d = indexOfUnquoted(row.content, header.delim);
      const c = indexOfUnquoted(row.content, ':');
      if (c !== -1 && (d === -1 || c < d)) break;
      this.checkBlankInSpan(row, rows.length);
      this.i++;
      const cells = splitUnquoted(row.content, header.delim);
      if (this.strict && cells.length !== leaves) {
        fail('row_width', row.lineNo,
          `row has ${cells.length} cells but the header declares ${leaves} leaf fields`);
      }
      const obj = materialize(header.fields, cells.map((x) => decodeToken(x, row.lineNo)));
      const rowPath = ptr(path, rows.length);
      this.recordSingle(rowPath, row, obj);
      rows.push(obj);
    }
    if (this.strict && rows.length !== header.length) {
      fail('count_mismatch', line.lineNo,
        `tabular array declares [${header.length}] but carries ${rows.length} rows`);
    }
    return rows;
  }

  parseKeyedScope(header, line, depth, path, hyphen) {
    const rowDepth = depth + 1;
    const leaves = leafNames(header.fields).length;
    const out = {};
    let count = 0;
    this.recordContainer(path, line, sigOf('keyed', header.delim, header.length, header.fields), {
      form: 'keyed',
      delim: header.delim,
      hyphen,
    });
    while (this.i < this.lines.length) {
      const row = this.peek();
      if (row.depth < rowDepth) break;
      if (row.depth > rowDepth) {
        fail('over_indent', row.lineNo, `entry row is indented deeper than the keyed scope (depth ${row.depth}, expected ${rowDepth})`);
      }
      // Spec 9.5: at entry depth, every line with an unquoted colon is an entry
      // row; a line without one is an error.
      const c = indexOfUnquoted(row.content, ':');
      if (c === -1) {
        if (this.strict) fail('entry_row', row.lineNo, 'line at entry depth has no unquoted colon');
        this.i++;
        continue;
      }
      this.checkBlankInSpan(row, count);
      this.i++;
      const entryKey = decodeKeyToken(row.content.slice(0, c), row.lineNo);
      const body = row.content.slice(c + 1);
      const cells = trimSpaces(body) === '' ? [] : splitUnquoted(body, header.delim);
      if (this.strict && cells.length !== leaves) {
        fail('row_width', row.lineNo,
          `entry row has ${cells.length} cells but the header declares ${leaves} leaf fields`);
      }
      const obj = materialize(header.fields, cells.map((x) => decodeToken(x, row.lineNo)));
      this.recordSingle(ptr(path, entryKey), row, obj);
      this.assignKey(out, entryKey, obj, row);
      count++;
    }
    if (this.strict && count !== header.length) {
      fail('count_mismatch', line.lineNo,
        `keyed header declares [${header.length}:] but carries ${count} entry rows`);
    }
    return out;
  }

  parseListScope(header, line, depth, path, hyphen) {
    const itemDepth = depth + 1;
    const items = [];
    this.recordContainer(path, line, sigOf('list', header.delim, header.length, null), {
      form: 'list',
      delim: header.delim,
      hyphen,
    });
    while (this.i < this.lines.length) {
      const item = this.peek();
      if (item.depth < itemDepth) break;
      if (item.depth > itemDepth) {
        fail('over_indent', item.lineNo, `list item is indented deeper than its scope (depth ${item.depth}, expected ${itemDepth})`);
      }
      if (item.content !== '-' && !item.content.startsWith('- ')) break;
      this.checkBlankInSpan(item, items.length);
      this.i++;
      items.push(this.parseListItem(item, itemDepth, ptr(path, items.length)));
    }
    if (this.strict && items.length !== header.length) {
      fail('count_mismatch', line.lineNo,
        `array declares [${header.length}] but carries ${items.length} list items`);
    }
    return items;
  }

  parseListItem(line, depth, path) {
    const rest = line.content === '-' ? '' : line.content.slice(2);
    if (rest === '') {
      // Spec 10: a bare hyphen is an empty-object list item.
      this.recordSingle(path, line, {});
      return {};
    }
    if (trimSpaces(rest) === '[]') {
      this.recordSingle(path, line, []);
      return [];
    }
    const header = parseHeader(rest, line.lineNo, this.strict);
    if (header && header.key === null) {
      if (header.fields) {
        fail('keyless_header', line.lineNo, 'a keyless fields-bearing header is only valid at the document root');
      }
      // Spec 10: a keyless header on a hyphen line is the item itself and
      // stands at the item's own depth.
      return this.consumeHeaderValue(header, line, depth, path);
    }
    if (header || indexOfUnquoted(rest, ':') !== -1) {
      // Object list item: the first field is carried on the hyphen line and
      // stands at depth+1 for all scope purposes (spec 10).
      const obj = {};
      this.recordContainer(path, null, 'item', { form: 'item' });
      this.consumeField(rest, line, depth + 1, path, obj, true);
      this.parseObjectScope(depth + 1, path, obj);
      return obj;
    }
    const value = decodeToken(rest, line.lineNo);
    this.recordSingle(path, line, value);
    return value;
  }

  // Spec 12: a blank line inside a header span is a strict-mode error. A blank
  // between the header and the first row/item/entry is not part of the span.
  checkBlankInSpan(line, memberIndex) {
    if (this.strict && memberIndex > 0 && line.hasBlankBefore) {
      fail('blank_in_span', line.lineNo, 'blank line inside a header span');
    }
  }
}

// Walks a header field tree, taking one cell per leaf in depth-first pre-order.
function materialize(tree, cells, cursor = { i: 0 }) {
  const obj = {};
  for (const f of tree) {
    if (f.children) obj[f.name] = materialize(f.children, cells, cursor);
    else obj[f.name] = cells[cursor.i++];
  }
  return obj;
}

function sigOf(form, delim, length, fields) {
  return `${form}|${delim}|${length}|${fields ? JSON.stringify(stripTree(fields)) : ''}`;
}

function stripTree(tree) {
  return tree.map((f) => (f.children ? [f.name, stripTree(f.children)] : f.name));
}

// ===========================================================================
// Encoder (spec 2, 3, 7, 9, 12)
// ===========================================================================

// JS Number#toString already produces the spec's canonical decimal form: it
// switches to exponent notation exactly outside [1e-6, 1e21), uses a lowercase
// "e" with an explicit sign, emits no trailing fractional zeros, and renders
// -0 as "0".
function formatNumber(n) {
  return Number.isFinite(n) ? String(n) : 'null';
}

function needsQuote(s, delim) {
  if (s === '') return true;
  if (/^[ \t]/.test(s) || /[ \t]$/.test(s)) return true;
  if (s === 'true' || s === 'false' || s === 'null') return true;
  if (ENCODER_NUMERIC_LIKE.test(s)) return true;
  if (/[:"\\[\]{}]/.test(s)) return true;
  if (/[\u0000-\u001f]/.test(s)) return true;
  if (s[0] === '-' || s[0] === '#') return true;
  if (delim && s.includes(delim)) return true;
  return false;
}

function quoteString(s) {
  if (LONE_SURROGATE.test(s)) {
    throw new ToonError('string contains an unpaired surrogate and is not representable in TOON', {
      code: 'lone_surrogate',
    });
  }
  let out = '"';
  for (const ch of s) {
    if (ch === '\\') { out += '\\\\'; continue; }
    if (ch === '"') { out += '\\"'; continue; }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    const code = ch.codePointAt(0);
    if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += ch;
  }
  return `${out}"`;
}

function encodePrimitive(v, delim) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return needsQuote(v, delim) ? quoteString(v) : v;
  throw new ToonError(`cannot encode a value of type ${typeof v} as a TOON primitive`, {
    code: 'unencodable',
  });
}

function encodeKey(k) {
  return BARE_KEY.test(k) ? k : quoteString(k);
}

// Spec 9.3: derive the header field tree for an array of uniform objects, or
// null when the array does not qualify for tabular form.
function fieldTreeOf(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (!arr.every(isPlainObject)) return null;
  const keys = Object.keys(arr[0]);
  if (keys.length === 0) return null;
  const keySet = new Set(keys);
  for (const el of arr) {
    const k = Object.keys(el);
    if (k.length !== keys.length || !k.every((x) => keySet.has(x))) return null;
  }
  const tree = [];
  for (const key of keys) {
    const column = arr.map((el) => el[key]);
    if (column.every(isPrimitive)) { tree.push({ name: key, children: null }); continue; }
    if (!column.every((v) => isPlainObject(v) && Object.keys(v).length > 0)) return null;
    const sub = fieldTreeOf(column);
    if (!sub) return null;
    tree.push({ name: key, children: sub });
  }
  return tree;
}

// Spec 9.5: an object of at least two uniform-object entries takes keyed form.
function keyedTreeOf(obj) {
  if (!isPlainObject(obj)) return null;
  const values = Object.values(obj);
  if (values.length < 2) return null;
  return fieldTreeOf(values);
}

function fieldsText(tree, delim) {
  return tree
    .map((f) => encodeKey(f.name) + (f.children ? `{${fieldsText(f.children, delim)}}` : ''))
    .join(delim);
}

function leafCells(obj, tree, delim, out = []) {
  for (const f of tree) {
    if (f.children) leafCells(obj[f.name], f.children, delim, out);
    else out.push(encodePrimitive(obj[f.name], delim));
  }
  return out;
}

class Emitter {
  constructor(opts) {
    const doc = opts.layout && opts.layout.layout ? opts.layout : null;
    this.layout = doc ? doc.layout : (opts.layout instanceof Map ? opts.layout : null);
    this.trailing = doc ? doc.trailing : [];
    this.indentSize = opts.indentSize ?? doc?.indentSize ?? DEFAULT_INDENT_SIZE;
    this.finalNewline = opts.finalNewline ?? doc?.finalNewline ?? false;
    this.delim = opts.delimiter ?? COMMA;
    if (!DELIMITERS.has(this.delim)) {
      throw new ToonError(`delimiter must be one of "," "\\t" "|"`, { code: 'bad_delimiter' });
    }
    this.out = [];
  }

  pad(depth) { return ' '.repeat(depth * this.indentSize); }

  entry(path) { return this.layout ? this.layout.get(path) : undefined; }

  // Emits the verbatim comment/blank run recorded before this node.
  trivia(path) {
    const e = this.entry(path);
    if (e && e.before.length) this.out.push(...e.before);
  }

  // The verbatim line for a single-line node, when the value is unchanged.
  reusable(path, value) {
    return usable(this.entry(path), value);
  }

  render() {
    let text = this.out.join('\n');
    if (this.finalNewline) text += '\n';
    return text;
  }

  emitRoot(value) {
    if (Array.isArray(value)) {
      if (value.length === 0) { this.trivia(''); this.out.push('[]'); }
      else this.emitArray(value, 0, '', '');
    } else if (isPlainObject(value)) {
      const tree = keyedTreeOf(value);
      const e = this.entry('');
      if (tree && (!e || e.form === 'keyed')) this.emitKeyed(value, tree, 0, '', '');
      else this.emitObjectFields(value, 0, '');
    } else {
      this.trivia('');
      const reuse = this.reusable('', value);
      this.out.push(reuse ? reuse.line : encodePrimitive(value, this.delim));
    }
    if (this.trailing.length) this.out.push(...this.trailing);
  }

  emitObjectFields(obj, depth, path) {
    for (const key of Object.keys(obj)) {
      this.emitField(key, obj[key], depth, ptr(path, key), null);
    }
  }

  // `hyphenPrefix` is set when this field is carried on a list-item hyphen
  // line (spec 10); the field then stands at `depth` but its line is prefixed
  // with the item's "- " marker instead of plain indentation.
  emitField(key, value, depth, path, hyphenPrefix) {
    this.trivia(path);
    const lead = hyphenPrefix ?? this.pad(depth);
    // A recorded line is only reusable in the position it was recorded in: a
    // line captured on a list-item hyphen carries the "- " marker in its text.
    const record = this.entry(path);
    const e = record && Boolean(record.hyphen) === Boolean(hyphenPrefix) ? record : undefined;

    if (Array.isArray(value) || isPlainObject(value)) {
      this.emitComposite(key, value, depth, path, lead, e);
      return;
    }
    const reuse = usable(e, value);
    if (reuse) { this.out.push(reuse.line); return; }
    this.out.push(`${lead}${encodeKey(key)}: ${encodePrimitive(value, this.delim)}`);
  }

  emitComposite(key, value, depth, path, lead, e) {
    const keyText = encodeKey(key);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        const reuse = usable(e, value);
        this.out.push(reuse ? reuse.line : `${lead}${keyText}: []`);
        return;
      }
      this.emitArray(value, depth, path, keyText, lead, e);
      return;
    }
    // Object: keyed tabular when it qualifies (9.5), else a nested scope.
    const tree = keyedTreeOf(value);
    if (tree && (!e || e.form === 'keyed')) {
      this.emitKeyed(value, tree, depth, path, keyText, lead, e);
      return;
    }
    const reuseHeader = e && e.sig === 'nested' && e.line !== null;
    this.out.push(reuseHeader ? e.line : `${lead}${keyText}:`);
    this.emitObjectFields(value, depth + 1, path);
  }

  // Chooses the array form. A form recorded by the parser wins whenever the
  // current value can still be rendered in it, so a hand-written list-form
  // document does not silently collapse to tabular on a rewrite.
  emitArray(value, depth, path, keyText, lead = this.pad(depth), e = this.entry(path)) {
    const delim = e?.delim ?? this.delim;
    const recorded = e?.form ?? (e?.sig?.startsWith('inline|') ? 'inline' : null);

    const tree = fieldTreeOf(value);
    const allPrimitive = value.every(isPrimitive);

    let form;
    if (recorded === 'tabular' && tree) form = 'tabular';
    else if (recorded === 'list') form = 'list';
    else if (recorded === 'inline' && allPrimitive) form = 'inline';
    else if (tree) form = 'tabular';
    else if (allPrimitive) form = 'inline';
    else form = 'list';

    if (form === 'inline') {
      const reuse = usable(e, value);
      if (reuse) { this.out.push(reuse.line); return; }
      const cells = value.map((v) => encodePrimitive(v, delim));
      this.out.push(`${lead}${keyText}[${value.length}${delimSym(delim)}]: ${cells.join(delim)}`);
      return;
    }

    if (form === 'tabular') {
      const sig = sigOf('tabular', delim, value.length, tree);
      const reuseHeader = e && e.line !== null && e.sig === sig;
      this.out.push(reuseHeader
        ? e.line
        : `${lead}${keyText}[${value.length}${delimSym(delim)}]{${fieldsText(tree, delim)}}:`);
      value.forEach((row, idx) => {
        const rowPath = ptr(path, idx);
        this.trivia(rowPath);
        const reuse = reuseHeader ? this.reusable(rowPath, row) : null;
        this.out.push(reuse
          ? reuse.line
          : this.pad(depth + 1) + leafCells(row, tree, delim).join(delim));
      });
      return;
    }

    const sig = sigOf('list', delim, value.length, null);
    const reuseHeader = e && e.line !== null && e.sig === sig;
    this.out.push(reuseHeader ? e.line : `${lead}${keyText}[${value.length}${delimSym(delim)}]:`);
    value.forEach((item, idx) => this.emitListItem(item, depth + 1, ptr(path, idx), delim));
  }

  emitListItem(item, depth, path, delim) {
    this.trivia(path);
    const lead = `${this.pad(depth)}- `;
    const reuse = this.reusable(path, item);
    if (reuse) { this.out.push(reuse.line); return; }

    if (Array.isArray(item)) {
      if (item.length === 0) { this.out.push(`${this.pad(depth)}- [0${delimSym(delim)}]:`); return; }
      if (item.every(isPrimitive)) {
        const cells = item.map((v) => encodePrimitive(v, delim));
        this.out.push(`${lead}[${item.length}${delimSym(delim)}]: ${cells.join(delim)}`);
        return;
      }
      // Spec 9.4: a nested array of objects in list-item position must itself
      // use list form, because a keyless fields-bearing header is root-only.
      this.out.push(`${lead}[${item.length}${delimSym(delim)}]:`);
      item.forEach((sub, idx) => this.emitListItem(sub, depth + 1, ptr(path, idx), delim));
      return;
    }
    if (isPlainObject(item)) {
      const keys = Object.keys(item);
      if (keys.length === 0) { this.out.push(this.pad(depth) + '-'); return; }
      const [first, ...others] = keys;
      this.emitField(first, item[first], depth + 1, ptr(path, first), lead);
      for (const k of others) this.emitField(k, item[k], depth + 1, ptr(path, k), null);
      return;
    }
    this.out.push(lead + encodePrimitive(item, delim));
  }

  emitKeyed(obj, tree, depth, path, keyText, lead = this.pad(depth), e = this.entry(path)) {
    const delim = e?.delim ?? this.delim;
    const keys = Object.keys(obj);
    const sig = sigOf('keyed', delim, keys.length, tree);
    const reuseHeader = e && e.line !== null && e.sig === sig;
    this.out.push(reuseHeader
      ? e.line
      : `${lead}${keyText}[${keys.length}:${delimSym(delim)}]{${fieldsText(tree, delim)}}:`);
    for (const k of keys) {
      const entryPath = ptr(path, k);
      this.trivia(entryPath);
      const reuse = reuseHeader ? this.reusable(entryPath, obj[k]) : null;
      this.out.push(reuse
        ? reuse.line
        : `${this.pad(depth + 1)}${encodeKey(k)}: ${leafCells(obj[k], tree, delim).join(delim)}`);
    }
  }
}

// A recorded single-line node is reusable only while its value is unchanged.
function usable(e, value) {
  if (!e || !e.single || e.line === null) return null;
  return isDeepStrictEqual(value, e.snapshot) ? e : null;
}

// Spec 6: comma is spelled by the *absence* of a delimiter symbol.
function delimSym(delim) {
  return delim === COMMA ? '' : delim;
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Decode a TOON document to a plain JS value. Comments, blank lines and
 * non-canonical spellings are discarded; use parseLossless to keep them.
 */
export function parse(text, opts = {}) {
  const p = new Parser(String(text), opts);
  const value = p.parseRoot();
  const next = p.peek();
  if (next && p.strict) {
    fail('trailing_content', next.lineNo, `line "${next.content}" belongs to no scope`);
  }
  return value;
}

/**
 * Decode a TOON document and keep everything a plain JS value cannot hold.
 *
 * Returns { value, layout, trailing, indentSize, finalNewline }. `layout` is a
 * Map from JSON Pointer to a record holding the verbatim source line that
 * produced that node, the comment/blank lines that preceded it, and either the
 * decoded snapshot (single-line nodes) or a shape signature (multi-line ones).
 *
 * serialize(value, { layout: doc }) reuses a recorded line whenever the node it
 * describes is unchanged, and falls back to canonical encoding otherwise. So an
 * untouched document round-trips byte-for-byte; an edited node loses only that
 * node's original spelling. Comments attach to the node that follows them, so
 * deleting a key also deletes the comment written above it.
 */
export function parseLossless(text, opts = {}) {
  const p = new Parser(String(text), opts);
  const value = p.parseRoot();
  const next = p.peek();
  if (next && p.strict) {
    fail('trailing_content', next.lineNo, `line "${next.content}" belongs to no scope`);
  }
  return {
    value,
    layout: p.layout,
    trailing: p.trailing,
    indentSize: p.indentSize,
    finalNewline: p.finalNewline,
  };
}

/**
 * Encode a JS value as TOON.
 * opts: { indentSize=2, delimiter=',', layout, finalNewline }
 * Pass a ToonDocument as `layout` to preserve the source's comments, blank
 * lines and spelling for every node that has not changed.
 */
export function serialize(value, opts = {}) {
  const em = new Emitter(opts);
  em.emitRoot(value);
  return em.render();
}

/** serialize(doc.value, { layout: doc }) - the identity round trip. */
export function reserialize(doc) {
  return serialize(doc.value, { layout: doc });
}

// ===========================================================================
// Markdown extraction
// ===========================================================================
//
// A project document is markdown that carries its TOON in fenced code blocks
// tagged `toon`. Everything outside a fence is ordinary markdown - real
// headings, real prose, real mermaid fences - so the file renders correctly in
// any viewer and still parses as data.
//
// The alternative, prefixing every non-TOON line with "#" so TOON reads it as a
// comment, forces a markdown heading to be written "# ## Requirements" and
// breaks the moment the document needs a mermaid diagram. Fences cost nothing
// and have neither problem.

// CommonMark 4.5: an opening fence is up to 3 spaces of indentation, then 3 or
// more backticks or tildes, then the info string. A backtick fence's info
// string may not contain a backtick.
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;

// The info string that marks a block as TOON. Compared case-insensitively
// against the first word, so "```toon" and "```TOON" both count.
const TOON_INFO = /^toon$/i;

// CommonMark 4.5: the closing fence is the same character, at least as long as
// the opening run, and carries no info string.
function closesFence(line, char, length) {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return m !== null && m[1][0] === char && m[1].length >= length;
}

// Removes up to `n` leading spaces, the way CommonMark strips an indented
// fence's indentation from its content.
function deindent(line, n) {
  let i = 0;
  while (i < n && line[i] === ' ') i++;
  return line.slice(i);
}

/**
 * Locate every ```toon fence in a markdown document.
 *
 * Returns an array of spans, in document order:
 *   { openLine, closeLine, bodyStart, bodyEnd, indent, body }
 * All four line numbers are 1-based and refer to the ORIGINAL document, which
 * is what makes an error message from a fence body point at a line the reader
 * can actually find. `bodyEnd` is `bodyStart - 1` for an empty fence.
 *
 * Fences of every kind are scanned, not only toon ones, so a ```toon line
 * sitting inside a ```mermaid block is content rather than a second opening.
 */
export function findToonBlocks(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (m === null) continue;
    const [, indent, marker, info] = m;
    const char = marker[0];
    if (char === '`' && info.includes('`')) continue;
    const isToon = TOON_INFO.test(info.trim().split(/[ \t]+/)[0] || '');
    const openLine = i + 1;

    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closesFence(lines[j], char, marker.length)) { close = j; break; }
    }
    if (close === -1) {
      // An unclosed toon fence is a real defect worth naming. An unclosed fence
      // of any other kind swallows the rest of the document by CommonMark's own
      // rules, so nothing after it can be a toon block either.
      if (isToon) {
        fail('unclosed_fence', openLine, 'a ```toon fence is opened here and never closed');
      }
      break;
    }
    if (isToon) {
      blocks.push({
        openLine,
        closeLine: close + 1,
        bodyStart: openLine + 1,
        bodyEnd: close,
        indent,
        body: lines.slice(i + 1, close).map((l) => deindent(l, indent.length)).join('\n'),
      });
    }
    i = close;
  }
  return blocks;
}

// Re-points a parse error at the line it occupies in the enclosing markdown
// file. An error that says "line 4" when the file is 200 lines long sends the
// reader looking in the wrong place, so the offset is applied before the error
// ever leaves this module.
function rethrowAtSourceLine(err, bodyStart, openLine) {
  if (err instanceof ToonError) {
    err.line = err.line == null ? openLine : err.line + bodyStart - 1;
  }
  throw err;
}

// Blocks merge into one document by top-level key. A key claimed twice is an
// error rather than a silent overwrite: the loser would vanish from every
// projection with nothing to show that it ever existed.
function mergedKeys(blocks, valueOf) {
  const owner = new Map();
  for (const b of blocks) {
    const v = valueOf(b);
    if (!isPlainObject(v)) {
      fail('not_mergeable', b.bodyStart,
        'a document with several ```toon fences needs every fence to be a key-value block');
    }
    for (const key of Object.keys(v)) {
      if (owner.has(key)) {
        fail('duplicate_key', b.bodyStart, `key "${key}" is defined by more than one \`\`\`toon fence`);
      }
      owner.set(key, b);
    }
  }
  return owner;
}

/**
 * Parse every ```toon fence in a markdown document and merge the results.
 *
 * Returns { value, blocks }. `blocks` carries one entry per fence, each the
 * span from findToonBlocks plus the `value` that fence parsed to. A document
 * with no toon fence yields { value: {}, blocks: [] } - an empty result, not an
 * error; the caller decides whether zero blocks is a problem.
 *
 * Error line numbers refer to the original markdown file.
 */
export function extract(text, opts = {}) {
  const blocks = findToonBlocks(text);
  for (const b of blocks) {
    try {
      b.value = parse(b.body, opts);
    } catch (err) {
      rethrowAtSourceLine(err, b.bodyStart, b.openLine);
    }
  }
  if (blocks.length === 0) return { value: {}, blocks };
  if (blocks.length === 1) return { value: blocks[0].value, blocks };

  const value = {};
  for (const [key, b] of mergedKeys(blocks, (b) => b.value)) value[key] = b.value[key];
  return { value, blocks };
}

/**
 * extract(), keeping everything a plain JS value cannot hold.
 *
 * Returns { value, blocks, source }, where every block carries a `doc` from
 * parseLossless. `value` is a live view over those documents: reading a
 * top-level key reads the owning fence's value, and assigning one writes it
 * back, so an edit made through `value` is an edit the owning fence will
 * re-emit.
 *
 * reassemble() then writes the whole markdown file back. Every byte outside a
 * toon fence is copied verbatim, and inside a fence the parseLossless guarantee
 * applies: an untouched record keeps its original spelling and the comments
 * written above it, and only an edited record is re-encoded canonically.
 */
export function extractLossless(text, opts = {}) {
  const source = String(text);
  const blocks = findToonBlocks(source);
  for (const b of blocks) {
    try {
      b.doc = parseLossless(b.body, opts);
    } catch (err) {
      rethrowAtSourceLine(err, b.bodyStart, b.openLine);
    }
  }
  if (blocks.length === 0) return { value: {}, blocks, source };
  if (blocks.length === 1) return { value: blocks[0].doc.value, blocks, source };

  const value = {};
  for (const [key, b] of mergedKeys(blocks, (b) => b.doc.value)) {
    Object.defineProperty(value, key, {
      enumerable: true,
      configurable: true,
      get: () => b.doc.value[key],
      set: (v) => { b.doc.value[key] = v; },
    });
  }
  return { value, blocks, source };
}

/**
 * Render an extractLossless() result back to markdown.
 *
 * Everything outside a ```toon fence - prose, headings, mermaid, the fence
 * lines themselves - is copied from the source byte for byte. Each fence body
 * is re-emitted by reserialize(), which reproduces the original body exactly
 * when nothing in it changed.
 */
export function reassemble(extracted) {
  const lines = String(extracted.source).split('\n');
  const out = [];
  let cursor = 0;
  for (const b of extracted.blocks) {
    // openLine is 1-based, so slicing to it keeps the opening fence line.
    out.push(...lines.slice(cursor, b.openLine));
    // split('\n') is the exact inverse of join('\n'), trailing newline
    // included, so the body needs no separate newline bookkeeping.
    for (const line of reserialize(b.doc).split('\n')) {
      out.push(line === '' ? '' : b.indent + line);
    }
    cursor = b.closeLine - 1;
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}

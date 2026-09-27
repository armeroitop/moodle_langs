/**
 * Lectura y escritura de ficheros de idioma de Moodle (`$string['clave'] = 'valor';`)
 * sin ejecutar PHP. No depende de la API de VSCode para poder probarse con Node.
 */

export interface LangEntry {
  key: string;
  /** Valor decodificado; si no es editable, el código PHP original de la expresión. */
  value: string;
  /** false si el valor no es un literal simple (concatenaciones, heredoc, interpolación...). */
  editable: boolean;
  /** Offset de `$string`. */
  stmtStart: number;
  /** Offset justo después del `;`. */
  stmtEnd: number;
  /** Rango de la expresión del valor (sin el `;`). */
  valueStart: number;
  valueEnd: number;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const ASSIGN_RE = /\$string\s*\[\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\]\s*=(?!=)\s*/y;
const HEREDOC_RE = /<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/y;

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[\w\x80-￿]/.test(c);
}

function skipQuoted(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
    } else if (text[j] === q) {
      return j + 1;
    } else {
      j++;
    }
  }
  return text.length;
}

function skipHeredoc(text: string, i: number): number {
  HEREDOC_RE.lastIndex = i;
  const m = HEREDOC_RE.exec(text);
  if (!m) {
    return i + 3;
  }
  const close = new RegExp(`^[ \\t]*${m[2]}\\b`, 'm');
  const rest = text.slice(HEREDOC_RE.lastIndex);
  const c = close.exec(rest);
  return c ? HEREDOC_RE.lastIndex + c.index + c[0].length : text.length;
}

/**
 * Si en `i` empieza un comentario, literal o heredoc, devuelve el offset donde acaba;
 * si no, devuelve -1.
 */
function skipNonCode(text: string, i: number): number {
  const c = text[i];
  if ((c === '/' && text[i + 1] === '/') || c === '#') {
    const e = text.indexOf('\n', i);
    return e < 0 ? text.length : e;
  }
  if (c === '/' && text[i + 1] === '*') {
    const e = text.indexOf('*/', i + 2);
    return e < 0 ? text.length : e + 2;
  }
  if (c === '\'' || c === '"') {
    return skipQuoted(text, i);
  }
  if (c === '<' && text.startsWith('<<<', i)) {
    return skipHeredoc(text, i);
  }
  return -1;
}

export function decodeSingleQuoted(body: string): string {
  return body.replace(/\\([\\'])/g, '$1');
}

/** Devuelve null si la cadena interpola variables. */
export function decodeDoubleQuoted(body: string): string | null {
  const simple: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', v: '\v', e: '\x1b', f: '\f', '\\': '\\', $: '$', '"': '"',
  };
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const n = body[i + 1];
      if (n in simple) {
        out += simple[n];
        i++;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '$' && /[A-Za-z_{]/.test(body[i + 1] ?? '')) {
      return null;
    }
    if (c === '{' && body[i + 1] === '$') {
      return null;
    }
    out += c;
  }
  return out;
}

/** Serializa como literal PHP con comilla simple, escapando lo mínimo. */
export function encodeValue(value: string): string {
  return '\'' + value.replace(/\\(?=[\\']|$)/g, '\\\\').replace(/'/g, '\\\'') + '\'';
}

function parseAssignment(text: string, start: number): LangEntry | null {
  ASSIGN_RE.lastIndex = start;
  const m = ASSIGN_RE.exec(text);
  if (!m) {
    return null;
  }
  const key = m[1] === '\'' ? decodeSingleQuoted(m[2]) : decodeDoubleQuoted(m[2]);
  if (key === null) {
    return null;
  }
  const valueStart = ASSIGN_RE.lastIndex;
  let j = valueStart;
  while (j < text.length && text[j] !== ';') {
    const skip = skipNonCode(text, j);
    j = skip >= 0 ? skip : j + 1;
  }
  if (j >= text.length) {
    return null;
  }
  let valueEnd = j;
  while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1])) {
    valueEnd--;
  }
  const raw = text.slice(valueStart, valueEnd);
  let value: string | null = null;
  const q = raw[0];
  if ((q === '\'' || q === '"') && skipQuoted(raw, 0) === raw.length) {
    const body = raw.slice(1, -1);
    value = q === '\'' ? decodeSingleQuoted(body) : decodeDoubleQuoted(body);
  }
  return {
    key,
    value: value ?? raw,
    editable: value !== null,
    stmtStart: start,
    stmtEnd: j + 1,
    valueStart,
    valueEnd,
  };
}

export function parseLangFile(text: string): LangEntry[] {
  const entries: LangEntry[] = [];
  let i = 0;
  while (i < text.length) {
    const skip = skipNonCode(text, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (text.startsWith('$string', i) && !isIdentChar(text[i + 7])) {
      const entry = parseAssignment(text, i);
      if (entry) {
        entries.push(entry);
        i = entry.stmtEnd;
        continue;
      }
    }
    i++;
  }
  return entries;
}

/** Texto anterior a la primera cadena (etiqueta PHP, licencia y docblock). */
export function fileHeader(text: string): string {
  const entries = parseLangFile(text);
  return entries.length ? text.slice(0, lineStart(text, entries[0].stmtStart)) : text;
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEnd(text: string, pos: number): number {
  const e = text.indexOf('\n', pos);
  return e < 0 ? text.length : e;
}

function statementLine(key: string, value: string): string {
  return `$string[${encodeValue(key)}] = ${encodeValue(value)};`;
}

/**
 * Calcula las ediciones mínimas para aplicar `changes` (clave -> valor, o null para borrar)
 * sobre `text`, respetando comentarios, orden y formato del resto del fichero.
 */
export function computeEdits(text: string, changes: Map<string, string | null>): TextEdit[] {
  const entries = parseLangFile(text);
  const byKey = new Map<string, LangEntry[]>();
  for (const e of entries) {
    const list = byKey.get(e.key) ?? [];
    list.push(e);
    byKey.set(e.key, list);
  }

  const edits: TextEdit[] = [];
  const newKeys: string[] = [];
  for (const [key, value] of changes) {
    const existing = byKey.get(key);
    if (value === null) {
      for (const e of existing ?? []) {
        const ls = lineStart(text, e.stmtStart);
        const le = lineEnd(text, e.stmtEnd);
        const aloneOnLine = text.slice(ls, e.stmtStart).trim() === '' && text.slice(e.stmtEnd, le).trim() === '';
        edits.push(aloneOnLine
          ? { start: ls, end: Math.min(le + 1, text.length), text: '' }
          : { start: e.stmtStart, end: e.stmtEnd, text: '' });
      }
    } else if (existing) {
      // En PHP gana la última asignación.
      const e = existing[existing.length - 1];
      if (e.editable && e.value !== value) {
        edits.push({ start: e.valueStart, end: e.valueEnd, text: encodeValue(value) });
      }
    } else {
      newKeys.push(key);
    }
  }

  if (newKeys.length) {
    newKeys.sort();
    const sorted = entries.every((e, idx) => idx === 0 || entries[idx - 1].key <= e.key);
    const inserts = new Map<number, string>();
    const add = (pos: number, s: string) => inserts.set(pos, (inserts.get(pos) ?? '') + s);
    for (const key of newKeys) {
      const value = changes.get(key) as string;
      const next = sorted ? entries.find(e => e.key > key) : undefined;
      if (next) {
        add(lineStart(text, next.stmtStart), statementLine(key, value) + '\n');
      } else if (entries.length) {
        add(lineEnd(text, entries[entries.length - 1].stmtEnd), '\n' + statementLine(key, value));
      } else {
        const prefix = text.length && !text.endsWith('\n') ? '\n' : '';
        add(text.length, prefix + statementLine(key, value) + '\n');
      }
    }
    for (const [pos, s] of inserts) {
      edits.push({ start: pos, end: pos, text: s });
    }
  }

  return edits.sort((a, b) => a.start - b.start);
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Edición única que convierte `a` en `b` (sin tocar el prefijo y sufijo comunes), o null si son iguales. */
export function diffEdit(a: string, b: string): TextEdit | null {
  if (a === b) {
    return null;
  }
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) {
    p++;
  }
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
    s++;
  }
  return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

function isCommentStart(text: string, i: number): boolean {
  return text[i] === '#' || (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'));
}

/**
 * Fin de la cabecera: tras el docblock `/** ... *\/` (y el `defined('MOODLE_INTERNAL')` que
 * le siga). Sin docblock, todo lo que precede a la primera cadena.
 */
function headerEnd(text: string, entries: LangEntry[]): number {
  const limit = entries.length ? lineStart(text, entries[0].stmtStart) : text.length;
  let i = 0;
  let end = -1;
  while (i < limit) {
    if (/\s/.test(text[i])) {
      i++;
    } else if (text.startsWith('<?php', i)) {
      i += 5;
    } else if (isCommentStart(text, i)) {
      const e = skipNonCode(text, i);
      if (end < 0 && text.startsWith('/**', i)) {
        end = e;
      }
      i = e;
    } else if (text.startsWith('defined(', i)) {
      i = lineEnd(text, i);
      if (end >= 0) {
        end = i;
      }
    } else {
      break;
    }
  }
  if (end < 0) {
    return limit;
  }
  return Math.min(limit, lineEnd(text, end) + 1);
}

interface Chunk {
  key: string;
  start: number;
  end: number;
}

/** Rango de texto de cada cadena: su(s) línea(s) completa(s) si está sola, con su comentario final. */
function chunks(text: string, entries: LangEntry[]): Chunk[] {
  return entries.map(e => {
    const ls = lineStart(text, e.stmtStart);
    const le = lineEnd(text, e.stmtEnd);
    const after = text.slice(e.stmtEnd, le).trim();
    const lineComment = after === '' || ((after.startsWith('//') || after.startsWith('#')) && !after.includes('?>'));
    return {
      key: e.key,
      start: text.slice(ls, e.stmtStart).trim() === '' ? ls : e.stmtStart,
      end: lineComment ? Math.min(le + 1, text.length) : e.stmtEnd,
    };
  });
}

/** Comentarios y líneas de código sueltas de un tramo entre cadenas. */
function gapPieces(gap: string): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < gap.length) {
    if (/\s/.test(gap[i])) {
      i++;
      continue;
    }
    const e = isCommentStart(gap, i) ? skipNonCode(gap, i) : lineEnd(gap, i);
    pieces.push(gap.slice(i, e).trim());
    i = e;
  }
  return pieces;
}

const withNewline = (s: string) => (s.endsWith('\n') ? s : s + '\n');

/**
 * Reordena `target` para que siga la estructura de `ref` (normalmente el fichero `en`):
 * mismas cadenas en el mismo orden y los mismos comentarios y líneas en blanco entre ellas.
 * Se conservan la cabecera de `target`, el texto de sus cadenas y los comentarios propios
 * (los que no están en `ref`), que viajan pegados a la cadena que les sigue. Las cadenas que
 * solo existen en `target` van al final.
 */
export function mirrorLayout(ref: string, target: string): string {
  const refEntries = parseLangFile(ref);
  if (!refEntries.length) {
    return target;
  }
  const refChunks = chunks(ref, refEntries);
  const refStart = Math.min(headerEnd(ref, refEntries), refChunks[0].start);
  const refGaps = refChunks.map((c, i) => ref.slice(i ? refChunks[i - 1].end : refStart, c.start));
  const refTrailer = ref.slice(refChunks[refChunks.length - 1].end);
  const refPieces = new Set([...refGaps, refTrailer].flatMap(gapPieces));

  const tEntries = parseLangFile(target);
  const tChunks = chunks(target, tEntries);
  const tStart = Math.min(headerEnd(target, tEntries), tChunks[0]?.start ?? target.length);
  const own = (gap: string) => gapPieces(gap).filter(p => !refPieces.has(p)).map(p => p + '\n').join('');
  const groups = new Map<string, string>();
  tChunks.forEach((c, i) => {
    const text = own(target.slice(i ? tChunks[i - 1].end : tStart, c.start)) + withNewline(target.slice(c.start, c.end));
    groups.set(c.key, (groups.get(c.key) ?? '') + text);
  });
  const tTrailer = own(target.slice(tChunks.length ? tChunks[tChunks.length - 1].end : tStart));

  let out = target.slice(0, tStart);
  if (out && !out.endsWith('\n')) {
    out += '\n';
  }
  refChunks.forEach((c, i) => {
    out += refGaps[i];
    out += groups.get(c.key) ?? '';
    groups.delete(c.key);
  });
  for (const text of groups.values()) {
    out += text;
  }
  out += refTrailer + tTrailer;
  return withNewline(out);
}

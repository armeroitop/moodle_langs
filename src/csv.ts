const BOM = '﻿';
const SEPARATORS = [';', ',', '\t'];

/** CSV (RFC 4180) con BOM para que Excel/LibreOffice reconozcan UTF-8. */
export function toCsv(rows: string[][], sep = ';'): string {
  const field = (s: string) => (/["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s);
  return BOM + rows.map(r => r.map(field).join(sep)).join('\r\n') + '\r\n';
}

/** Separador más frecuente fuera de comillas en la primera línea (`;` si no hay ninguno). */
function detectSeparator(text: string): string {
  const counts = new Map(SEPARATORS.map(s => [s, 0]));
  let quoted = false;
  for (const c of text) {
    if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && (c === '\n' || c === '\r')) {
      break;
    } else if (!quoted && counts.has(c)) {
      counts.set(c, counts.get(c)! + 1);
    }
  }
  let best = ';';
  for (const [s, n] of counts) {
    if (n > counts.get(best)!) {
      best = s;
    }
  }
  return best;
}

/** Lee un CSV detectando `;`, `,` o tabulador. Se descartan las filas totalmente vacías. */
export function parseCsv(text: string): string[][] {
  if (text.startsWith(BOM)) {
    text = text.slice(1);
  }
  const sep = detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const endRow = () => {
    row.push(field);
    if (row.some(f => f !== '')) {
      rows.push(row);
    }
    row = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' && field === '') {
      // Campo entrecomillado: puede contener separadores y saltos de línea.
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += text[i++];
      }
      continue;
    }
    if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') {
        i++;
      }
      endRow();
    } else {
      field += c;
    }
    i++;
  }
  if (field !== '' || row.length) {
    endRow();
  }
  return rows;
}

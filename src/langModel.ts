import * as path from 'path';
import * as vscode from 'vscode';
import { mirrorLayout, parseLangFile } from './langParser';

export interface CellValue {
  v: string;
  /** Editable (literal simple). */
  e: boolean;
}

export interface LangModel {
  component: string;
  /** Idiomas en orden de columnas: `en` primero y el resto alfabético. */
  langs: string[];
  /** Unión de claves: orden de `en` y después las que solo existen en otros idiomas. */
  keys: string[];
  values: Record<string, Record<string, CellValue>>;
  /** Idiomas cuyo fichero aún no existe. */
  missingFiles: string[];
  /** Idioma cuyo fichero marca el orden y los comentarios del resto (`en`), si existe. */
  refLang: string | null;
  /** Idiomas cuyo fichero no sigue el orden/comentarios de `refLang`. */
  unsynced: string[];
}

export const REF_LANG = 'en';

export function langFileUri(langDir: vscode.Uri, lang: string, component: string): vscode.Uri {
  return vscode.Uri.joinPath(langDir, lang, component + '.php');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function subdirs(dir: vscode.Uri): Promise<string[]> {
  const items = await vscode.workspace.fs.readDirectory(dir);
  return items.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name);
}

/** Texto actual del fichero, usando el documento abierto si lo hay (puede tener cambios sin guardar). */
export async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

/**
 * Componentes (nombres de fichero sin .php) presentes en la carpeta lang.
 * Normalmente un plugin tiene uno solo, p.ej. `enrol_itinerary`.
 */
export async function findComponents(langDir: vscode.Uri): Promise<string[]> {
  const langs = await subdirs(langDir);
  const source = langs.includes('en') ? ['en'] : langs;
  const names = new Set<string>();
  for (const lang of source) {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(langDir, lang))) {
      if (type === vscode.FileType.File && name.endsWith('.php')) {
        names.add(path.basename(name, '.php'));
      }
    }
  }
  return [...names].sort();
}

export async function loadModel(langDir: vscode.Uri, component: string): Promise<LangModel> {
  const langs = (await subdirs(langDir)).sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
  const values: LangModel['values'] = {};
  const keys: string[] = [];
  const seen = new Set<string>();
  const missingFiles: string[] = [];
  const texts = new Map<string, string>();

  for (const lang of langs) {
    values[lang] = {};
    const uri = langFileUri(langDir, lang, component);
    if (!(await exists(uri))) {
      missingFiles.push(lang);
      continue;
    }
    const text = await readText(uri);
    texts.set(lang, text);
    for (const entry of parseLangFile(text)) {
      values[lang][entry.key] = { v: entry.value, e: entry.editable };
      if (!seen.has(entry.key)) {
        seen.add(entry.key);
        keys.push(entry.key);
      }
    }
  }

  const refText = texts.get(REF_LANG);
  const refLang = refText === undefined ? null : REF_LANG;
  const unsynced = refText === undefined
    ? []
    : [...texts].filter(([lang, text]) => lang !== REF_LANG && mirrorLayout(refText, text) !== text).map(([lang]) => lang);

  return { component, langs, keys, values, missingFiles, refLang, unsynced };
}

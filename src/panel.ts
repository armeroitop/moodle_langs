import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { applyEdits, computeEdits, diffEdit, fileHeader, mirrorLayout, parseLangFile } from './langParser';
import { langFileUri, loadModel, readText } from './langModel';

/** Cambio enviado por el webview. `value: null` borra la clave; `lang: '*'` aplica a todos los idiomas. */
interface Change {
  lang: string;
  key: string;
  value: string | null;
}

type Message =
  | { type: 'ready' }
  | { type: 'save'; changes: Change[] }
  | { type: 'dirty'; count: number }
  | { type: 'addLang' }
  | { type: 'openFile'; lang: string; key?: string };

const LANG_CODE_RE = /^[a-z]{2,3}(_[a-z0-9]+)*$/;

export class LangPanel {
  private static readonly panels = new Map<string, LangPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private saving = false;

  static show(context: vscode.ExtensionContext, langDir: vscode.Uri, component: string) {
    const id = langDir.toString() + '#' + component;
    const existing = LangPanel.panels.get(id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('moodleLang', `Traducciones: ${component}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    LangPanel.panels.set(id, new LangPanel(panel, context.extensionUri, langDir, component, () => LangPanel.panels.delete(id)));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly langDir: vscode.Uri,
    private readonly component: string,
    onDispose: () => void,
  ) {
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: Message) => this.onMessage(m), null, this.disposables);

    // Recargar si los ficheros cambian fuera del panel (git pull, edición a mano...).
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(langDir, '**/*.php'));
    const schedule = () => this.scheduleReload();
    watcher.onDidChange(schedule, null, this.disposables);
    watcher.onDidCreate(schedule, null, this.disposables);
    watcher.onDidDelete(schedule, null, this.disposables);
    this.disposables.push(watcher);

    panel.onDidDispose(() => {
      onDispose();
      clearTimeout(this.reloadTimer);
      this.disposables.forEach(d => d.dispose());
    }, null, this.disposables);
  }

  private async onMessage(m: Message) {
    try {
      switch (m.type) {
        case 'ready':
          await this.postModel(false);
          break;
        case 'save':
          await this.save(m.changes);
          break;
        case 'dirty':
          this.panel.title = `${m.count ? '● ' : ''}Traducciones: ${this.component}`;
          break;
        case 'addLang':
          await this.addLang();
          break;
        case 'openFile':
          await this.openFile(m.lang, m.key);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Moodle Lang: ${msg}`);
      if (m.type === 'save') {
        this.panel.webview.postMessage({ type: 'saveFailed' });
      }
    }
  }

  private scheduleReload() {
    if (this.saving) {
      return;
    }
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.postModel(false).catch(() => undefined), 300);
  }

  private async postModel(saved: boolean) {
    const model = await loadModel(this.langDir, this.component);
    await this.panel.webview.postMessage({ type: 'load', model, saved });
  }

  private async save(changes: Change[]) {
    const model = await loadModel(this.langDir, this.component);
    const byLang = new Map<string, Map<string, string | null>>();
    for (const c of changes) {
      const langs = c.lang === '*' ? model.langs : [c.lang];
      for (const lang of langs) {
        if (!byLang.has(lang)) {
          byLang.set(lang, new Map());
        }
        byLang.get(lang)!.set(c.key, c.value);
      }
    }

    this.saving = true;
    try {
      const edit = new vscode.WorkspaceEdit();
      const docs: vscode.TextDocument[] = [];
      // El idioma de referencia va primero: su texto final marca el orden de los demás.
      let refText: string | undefined;
      const langs = model.refLang ? [model.refLang, ...model.langs.filter(l => l !== model.refLang)] : model.langs;
      for (const lang of langs) {
        const langChanges = byLang.get(lang) ?? new Map<string, string | null>();
        const uri = langFileUri(this.langDir, lang, this.component);
        if (model.missingFiles.includes(lang)) {
          const additions = new Map([...langChanges].filter(([, v]) => v !== null));
          if (additions.size) {
            const header = await this.newFileHeader(model.langs, lang);
            const text = this.layout(applyEdits(header, computeEdits(header, additions)), refText);
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
          }
          continue;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        let edits = computeEdits(text, langChanges);
        if (lang === model.refLang) {
          refText = applyEdits(text, edits);
        } else {
          // El resto se reescribe con el orden de la referencia, en una sola edición.
          const e = diffEdit(text, this.layout(applyEdits(text, edits), refText));
          edits = e ? [e] : [];
        }
        for (const e of edits) {
          edit.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
        }
        if (edits.length) {
          docs.push(doc);
        }
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error('no se han podido aplicar los cambios.');
      }
      for (const doc of docs) {
        await doc.save();
      }
    } finally {
      this.saving = false;
    }
    await this.postModel(true);
  }

  /** Aplica el orden y los comentarios del fichero de referencia, si lo hay. */
  private layout(text: string, refText: string | undefined): string {
    return refText === undefined ? text : mirrorLayout(refText, text);
  }

  /** Cabecera para un fichero nuevo: se copia la de otro idioma (preferiblemente `en`). */
  private async newFileHeader(langs: string[], lang: string): Promise<string> {
    for (const other of langs) {
      if (other === lang) {
        continue;
      }
      try {
        const header = fileHeader(await readText(langFileUri(this.langDir, other, this.component)));
        return header.replace(new RegExp(`language '${other}'`, 'g'), `language '${lang}'`);
      } catch {
        // Ese idioma tampoco tiene fichero; probar el siguiente.
      }
    }
    return [
      '<?php',
      '// This file is part of Moodle - https://moodle.org/',
      '//',
      '// Moodle is free software: you can redistribute it and/or modify',
      '// it under the terms of the GNU General Public License as published by',
      '// the Free Software Foundation, either version 3 of the License, or',
      '// (at your option) any later version.',
      '//',
      '// Moodle is distributed in the hope that it will be useful,',
      '// but WITHOUT ANY WARRANTY; without even the implied warranty of',
      '// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the',
      '// GNU General Public License for more details.',
      '//',
      '// You should have received a copy of the GNU General Public License',
      '// along with Moodle.  If not, see <https://www.gnu.org/licenses/>.',
      '',
      '/**',
      ` * Strings for component '${this.component}', language '${lang}'.`,
      ' *',
      ` * @package    ${this.component}`,
      ' * @license    https://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later',
      ' */',
      '',
      '',
    ].join('\n');
  }

  private async addLang() {
    const lang = await vscode.window.showInputBox({
      prompt: 'Código del nuevo idioma (p.ej. fr, pt_br)',
      validateInput: v => (LANG_CODE_RE.test(v) ? undefined : 'Código de idioma de Moodle no válido'),
    });
    if (!lang) {
      return;
    }
    // El fichero se crea al guardar la primera cadena de ese idioma.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.langDir, lang));
    await this.postModel(false);
  }

  private async openFile(lang: string, key?: string) {
    const doc = await vscode.workspace.openTextDocument(langFileUri(this.langDir, lang, this.component));
    const entry = key ? parseLangFile(doc.getText()).filter(e => e.key === key).pop() : undefined;
    const pos = doc.positionAt(entry?.stmtStart ?? 0);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      selection: new vscode.Range(pos, pos),
    });
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('main.css')}">
<title>Traducciones</title>
</head>
<body>
<header class="toolbar">
  <input id="filter" type="search" placeholder="Filtrar por clave o texto…">
  <label><input id="onlyMissing" type="checkbox"> Solo con traducciones pendientes</label>
  <span class="spacer"></span>
  <input id="newKey" type="text" placeholder="nueva_clave">
  <button id="addKey" class="secondary">Añadir clave</button>
  <button id="addLang" class="secondary">Añadir idioma</button>
  <button id="sync" class="secondary" hidden>Ordenar como en</button>
  <button id="save" disabled>Guardar</button>
  <span id="status"></span>
</header>
<main>
  <table id="grid"><thead></thead><tbody></tbody></table>
</main>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

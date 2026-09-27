import * as path from 'path';
import * as vscode from 'vscode';
import { findComponents } from './langModel';
import { LangPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('moodleLang.open', async (uri?: vscode.Uri) => {
      try {
        await open(context, uri);
      } catch (err) {
        vscode.window.showErrorMessage(`Moodle Lang: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

export function deactivate() {}

async function isDir(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

/**
 * Busca la carpeta `lang` a partir de lo que se ha pulsado: la propia carpeta `lang`,
 * una subcarpeta suya (`lang/es`) o la raíz del plugin que la contiene.
 */
async function resolveLangDir(start: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (await isDir(vscode.Uri.joinPath(start, 'lang'))) {
    return vscode.Uri.joinPath(start, 'lang');
  }
  let dir = start;
  for (let i = 0; i < 3; i++) {
    if (path.posix.basename(dir.path) === 'lang') {
      return dir;
    }
    dir = vscode.Uri.joinPath(dir, '..');
  }
  return undefined;
}

async function open(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  // Desde la paleta de comandos no llega carpeta: se usa la del fichero activo.
  const start = uri ?? (vscode.window.activeTextEditor
    ? vscode.Uri.joinPath(vscode.window.activeTextEditor.document.uri, '..')
    : undefined);
  if (!start) {
    throw new Error('pulsa con el botón derecho sobre la carpeta "lang" de un plugin.');
  }
  const langDir = await resolveLangDir(start);
  if (!langDir) {
    throw new Error(`no se encuentra una carpeta "lang" en ${vscode.workspace.asRelativePath(start)}.`);
  }

  const components = await findComponents(langDir);
  let component: string | undefined = components[0];
  if (components.length > 1) {
    component = await vscode.window.showQuickPick(components, { placeHolder: 'Fichero de idioma a editar' });
  }
  if (!component) {
    if (!components.length) {
      throw new Error(`no hay ficheros .php en ${vscode.workspace.asRelativePath(langDir)}.`);
    }
    return;
  }

  LangPanel.show(context, langDir, component);
}

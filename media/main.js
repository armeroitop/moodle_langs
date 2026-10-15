// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{component: string, langs: string[], keys: string[], values: Record<string, Record<string, {v: string, e: boolean, d?: number[]}>>, missingFiles: string[], refLang: string | null, unsynced: string[]} | null} */
  let model = null;
  /** Ediciones pendientes: "lang\0key" -> valor. */
  let dirty = new Map();
  /** Claves marcadas para borrar. */
  let deleted = new Set();
  /** Claves nuevas que aún no existen en ningún fichero. */
  let added = [];
  let saving = false;

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const thead = /** @type {HTMLElement} */ (document.querySelector('#grid thead'));
  const tbody = /** @type {HTMLElement} */ (document.querySelector('#grid tbody'));
  const filter = /** @type {HTMLInputElement} */ ($('filter'));
  const onlyMissing = /** @type {HTMLInputElement} */ ($('onlyMissing'));
  const newKey = /** @type {HTMLInputElement} */ ($('newKey'));
  const saveBtn = /** @type {HTMLButtonElement} */ ($('save'));
  const syncBtn = /** @type {HTMLButtonElement} */ ($('sync'));
  const status = $('status');

  const cellId = (lang, key) => lang + '\0' + key;
  const original = (lang, key) => model?.values[lang]?.[key];
  const current = (lang, key) => {
    const id = cellId(lang, key);
    return dirty.has(id) ? dirty.get(id) : (original(lang, key)?.v ?? '');
  };
  const allKeys = () => [...(model?.keys ?? []), ...added];
  const isPending = (lang, key) => current(lang, key).trim() === '';

  function el(tag, props = {}, ...children) {
    const { dataset, ...rest } = /** @type {any} */ (props);
    const node = Object.assign(document.createElement(tag), rest);
    Object.assign(node.dataset, dataset);
    node.append(...children);
    return node;
  }

  function autosize(/** @type {HTMLTextAreaElement} */ ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function render() {
    if (!model) {
      return;
    }
    const m = model;
    thead.replaceChildren(el('tr', {},
      el('th', { className: 'key' }, 'Clave'),
      ...m.langs.map(lang => {
        const open = el('a', { href: '#', title: 'Abrir fichero', textContent: '↗' });
        open.addEventListener('click', e => {
          e.preventDefault();
          vscode.postMessage({ type: 'openFile', lang });
        });
        const dups = Object.values(m.values[lang] ?? {}).filter(c => c.d).length;
        const th = el('th', { dataset: { lang } },
          el('span', { className: 'lang' }, lang),
          el('span', { className: 'count' }),
          dups ? el('span', { className: 'dupcount', title: `${dups} claves asignadas más de una vez en el fichero` }, `⚠ ${dups}`) : '',
          m.missingFiles.includes(lang) ? el('span', { className: 'nofile', title: 'Se creará al guardar' }, 'nuevo') : open,
        );
        return th;
      }),
      el('th', { className: 'actions' }),
    ));

    tbody.replaceChildren(...allKeys().map(key => {
      const keyCell = el('td', { className: 'key', title: 'Doble clic: abrir en el fichero' }, key);
      keyCell.addEventListener('dblclick', () => {
        const lang = m.langs.find(l => original(l, key));
        if (lang) {
          vscode.postMessage({ type: 'openFile', lang, key });
        }
      });
      const del = el('button', { className: 'icon', title: 'Borrar clave en todos los idiomas', textContent: '✕' });
      del.addEventListener('click', () => toggleDelete(key));
      const row = el('tr', { dataset: { key } },
        keyCell,
        ...m.langs.map(lang => {
          const orig = original(lang, key);
          const ta = el('textarea', { rows: 1, value: current(lang, key), spellcheck: true });
          ta.dataset.lang = lang;
          ta.dataset.key = key;
          if (orig && !orig.e) {
            ta.readOnly = true;
            ta.title = 'Expresión PHP compleja: edítala directamente en el fichero';
          }
          ta.addEventListener('input', () => onInput(ta));
          if (!orig?.d) {
            return el('td', {}, ta);
          }
          const dup = el('a', {
            href: '#',
            className: 'dup',
            title: 'En PHP vale la última asignación; las anteriores sobran. Clic: abrir el fichero en la última.',
            textContent: `⚠ Repetida en las líneas ${orig.d.join(', ')}`,
          });
          dup.addEventListener('click', e => {
            e.preventDefault();
            vscode.postMessage({ type: 'openFile', lang, key });
          });
          return el('td', { className: 'duplicate' }, ta, dup);
        }),
        el('td', { className: 'actions' }, del),
      );
      return row;
    }));

    tbody.querySelectorAll('textarea').forEach(ta => autosize(/** @type {HTMLTextAreaElement} */ (ta)));
    refresh();
  }

  function onInput(/** @type {HTMLTextAreaElement} */ ta) {
    const { lang, key } = /** @type {{lang: string, key: string}} */ (ta.dataset);
    const orig = original(lang, key);
    const id = cellId(lang, key);
    if ((orig && ta.value === orig.v) || (!orig && ta.value === '')) {
      dirty.delete(id);
    } else {
      dirty.set(id, ta.value);
    }
    autosize(ta);
    refresh();
  }

  function toggleDelete(key) {
    if (added.includes(key)) {
      added = added.filter(k => k !== key);
      for (const id of [...dirty.keys()]) {
        if (id.endsWith('\0' + key)) {
          dirty.delete(id);
        }
      }
      render();
      return;
    }
    deleted.has(key) ? deleted.delete(key) : deleted.add(key);
    refresh();
  }

  /** Actualiza clases, contadores, filtros y estado del botón sin reconstruir la tabla. */
  function refresh() {
    if (!model) {
      return;
    }
    const text = filter.value.trim().toLowerCase();
    const pendingByLang = Object.fromEntries(model.langs.map(l => [l, 0]));

    tbody.querySelectorAll('tr').forEach(row => {
      const key = /** @type {string} */ (row.dataset.key);
      const isDeleted = deleted.has(key);
      let rowPending = false;
      let matches = !text || key.toLowerCase().includes(text);
      row.querySelectorAll('textarea').forEach(node => {
        const ta = /** @type {HTMLTextAreaElement} */ (node);
        const lang = /** @type {string} */ (ta.dataset.lang);
        const pending = isPending(lang, key);
        if (pending && !isDeleted) {
          pendingByLang[lang]++;
          rowPending = true;
        }
        matches = matches || ta.value.toLowerCase().includes(text);
        ta.disabled = isDeleted;
        const td = /** @type {HTMLElement} */ (ta.parentElement);
        td.classList.toggle('pending', pending);
        td.classList.toggle('dirty', dirty.has(cellId(lang, key)));
        td.classList.toggle('readonly', ta.readOnly);
      });
      row.classList.toggle('deleted', isDeleted);
      row.classList.toggle('added', added.includes(key));
      row.hidden = !matches || (onlyMissing.checked && !rowPending);
    });

    thead.querySelectorAll('th[data-lang]').forEach(th => {
      const lang = /** @type {string} */ (/** @type {HTMLElement} */ (th).dataset.lang);
      const count = /** @type {HTMLElement} */ (th.querySelector('.count'));
      const n = pendingByLang[lang];
      count.textContent = n ? String(n) : '✓';
      count.title = n ? `${n} cadenas sin traducir` : 'Completo';
      count.classList.toggle('ok', !n);
    });

    const changes = collectChanges().length;
    saveBtn.disabled = saving || !changes;
    syncBtn.hidden = !model.unsynced.length;
    syncBtn.disabled = saving;
    syncBtn.textContent = `Ordenar como ${model.refLang}`;
    syncBtn.title = `Aplicar el orden y los comentarios de ${model.refLang} a: ${model.unsynced.join(', ')}`;
    status.textContent = saving ? 'Guardando…' : changes ? `${changes} cambios sin guardar` : '';
    vscode.postMessage({ type: 'dirty', count: changes });
  }

  function collectChanges() {
    const changes = [];
    for (const [id, value] of dirty) {
      const [lang, key] = id.split('\0');
      if (!deleted.has(key)) {
        changes.push({ lang, key, value });
      }
    }
    for (const key of deleted) {
      changes.push({ lang: '*', key, value: null });
    }
    return changes;
  }

  /** Guarda los cambios; con `force` guarda aunque no haya (para reordenar los ficheros). */
  function save(force = false) {
    const changes = collectChanges();
    if ((!changes.length && !force) || saving) {
      return;
    }
    saving = true;
    refresh();
    vscode.postMessage({ type: 'save', changes });
  }

  function addKey() {
    const key = newKey.value.trim();
    if (!/^[\w:./-]+$/.test(key)) {
      status.textContent = 'Clave no válida (letras, números, _ : . / -)';
      return;
    }
    if (!allKeys().includes(key)) {
      added.push(key);
      render();
    }
    newKey.value = '';
    filter.value = '';
    refresh();
    const row = tbody.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: 'center' });
    /** @type {HTMLTextAreaElement | null | undefined} */ (row?.querySelector('textarea:not([readonly])'))?.focus();
  }

  /** Envía la tabla tal como se ve (con ediciones sin guardar, sin las claves marcadas para borrar). */
  function exportCsv() {
    if (!model) {
      return;
    }
    const langs = model.langs;
    const rows = [['Clave', ...langs], ...allKeys().filter(k => !deleted.has(k)).map(k => [k, ...langs.map(l => current(l, k))])];
    vscode.postMessage({ type: 'export', rows });
  }

  /** Aplica los valores de un CSV como cambios pendientes. */
  function applyImport(/** @type {{lang: string, key: string, value: string}[]} */ values, /** @type {number} */ skippedRows) {
    if (!model) {
      return;
    }
    const newKeys = new Set();
    let imported = 0;
    let readonly = 0;
    for (const { lang, key, value } of values) {
      if (!model.langs.includes(lang)) {
        continue;
      }
      if (!allKeys().includes(key)) {
        added.push(key);
        newKeys.add(key);
      }
      const orig = original(lang, key);
      if (orig && !orig.e) {
        readonly++;
        continue;
      }
      const id = cellId(lang, key);
      if (orig && orig.v === value) {
        dirty.delete(id);
      } else {
        dirty.set(id, value);
        imported++;
      }
    }
    render();
    const skipped = [
      readonly ? `${readonly} celdas de solo lectura` : '',
      skippedRows ? `${skippedRows} filas con clave no válida o repetida` : '',
    ].filter(Boolean).join(', ');
    status.textContent = `CSV: ${imported} cadenas cambiadas, ${newKeys.size} claves nuevas` +
      (skipped ? ` (omitidas: ${skipped})` : '') + '. Revisa y pulsa Guardar.';
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'load') {
      model = msg.model;
      if (msg.saved) {
        dirty = new Map();
        deleted = new Set();
        added = [];
        saving = false;
      } else {
        // Recarga por cambios externos: se conservan las ediciones pendientes.
        added = added.filter(k => !model?.keys.includes(k));
        deleted = new Set([...deleted].filter(k => model?.keys.includes(k)));
      }
      render();
    } else if (msg.type === 'imported') {
      applyImport(msg.values, msg.skippedRows);
    } else if (msg.type === 'saveFailed') {
      saving = false;
      refresh();
    }
  });

  filter.addEventListener('input', refresh);
  onlyMissing.addEventListener('change', refresh);
  saveBtn.addEventListener('click', () => save());
  syncBtn.addEventListener('click', () => save(true));
  $('addKey').addEventListener('click', addKey);
  newKey.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      addKey();
    }
  });
  $('addLang').addEventListener('click', () => vscode.postMessage({ type: 'addLang' }));
  $('export').addEventListener('click', exportCsv);
  $('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  // La cabecera de la tabla se queda fija justo debajo de la barra de herramientas.
  const toolbar = /** @type {HTMLElement} */ (document.querySelector('.toolbar'));
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--toolbar-h', toolbar.offsetHeight + 'px');
  }).observe(toolbar);

  vscode.postMessage({ type: 'ready' });
})();

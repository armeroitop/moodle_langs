# Moodle Lang Editor

Editor en tabla de las cadenas de idioma de un plugin de Moodle (`lang/<idioma>/<componente>.php`).

## Uso
Clic derecho sobre la carpeta `lang` de un plugin (o sobre la carpeta del plugin, o `lang/es`)
→ **Editar traducciones (Moodle)**.

- Una columna por idioma (`en` primero); las celdas vacías o sin traducir se resaltan y
  la cabecera muestra cuántas faltan.
- Filtro por clave/texto y opción "solo pendientes".
- Añadir clave, borrar clave (en todos los idiomas), añadir idioma.
- **Guardar** (o `Ctrl+S` dentro del panel) modifica solo las líneas tocadas del fichero
  `en`: se conservan comentarios y orden. Las claves nuevas se insertan en orden alfabético
  si el fichero ya lo está; si no, al final. Los cambios se pueden deshacer desde el editor
  del fichero.
- `en` es la referencia: al guardar, los demás idiomas se reordenan para seguir el orden de
  sus cadenas y se copian sus comentarios y líneas en blanco entre cadenas (p.ej.
  `// Ajustes.` como separador de bloque). De cada idioma se conservan la cabecera, el texto
  de sus cadenas y sus comentarios propios (van pegados a la cadena siguiente); las claves
  que no existen en `en` quedan al final. Si algún fichero no sigue a `en`, aparece el botón
  **Ordenar como en** para aplicarlo sin más cambios.
- Las cadenas que no son un literal simple (concatenaciones, heredoc, `"$var"`) se muestran
  en solo lectura.
- Doble clic en una clave abre el fichero en esa línea.
- Las claves asignadas más de una vez en un fichero se marcan en su celda con las líneas
  de cada asignación (en PHP vale la última) y la cabecera del idioma muestra cuántas hay.

## Desarrollo
```
npm install
npm test          # compila y prueba el parser
F5                # abre una ventana de VSCode con la extensión cargada
npm run package   # genera el .vsix
```

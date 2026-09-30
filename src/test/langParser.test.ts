import * as assert from 'node:assert/strict';
import { applyEdits, computeEdits, diffEdit, duplicateLines, encodeValue, mirrorLayout, parseLangFile } from '../langParser';

const sample = `<?php
// $string['commented'] = 'no';
/* $string['block'] = 'no'; */
$string['a'] = 'Hola';
$string['b'] = 'l\\'usuari {$a}';
$string["c"] = "Line\\n\\"q\\"";
$string['d'] = 'x' . 'y';
$string['e'] = "Hi $name";
$string['f'] = <<<EOT
heredoc; text
EOT;
$string['g'] = 'con ; punto y coma';
`;

function test(name: string, fn: () => void) {
  fn();
  console.log('ok -', name);
}

test('parse', () => {
  const byKey = Object.fromEntries(parseLangFile(sample).map(e => [e.key, e]));
  assert.deepEqual(Object.keys(byKey), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(byKey.a.value, 'Hola');
  assert.equal(byKey.b.value, "l'usuari {$a}");
  assert.equal(byKey.c.value, 'Line\n"q"');
  assert.equal(byKey.d.editable, false);
  assert.equal(byKey.e.editable, false);
  assert.equal(byKey.f.editable, false);
  assert.equal(byKey.g.value, 'con ; punto y coma');
});

test('encode', () => {
  assert.equal(encodeValue("l'usuari"), "'l\\'usuari'");
  assert.equal(encodeValue('a\\nb'), "'a\\nb'");
  assert.equal(encodeValue('fin\\'), "'fin\\\\'");
  for (const v of ["l'a", '\\\'', '\\\\', 'x\\', '{$a->name}']) {
    const [e] = parseLangFile(`$string['k'] = ${encodeValue(v)};`);
    assert.equal(e.value, v);
  }
});

test('edit, delete, append (unsorted)', () => {
  const out = applyEdits(sample, computeEdits(sample, new Map<string, string | null>([
    ['a', "Hola l'amic"],
    ['g', null],
    ['zz', 'nuevo'],
  ])));
  assert.match(out, /\$string\['a'\] = 'Hola l\\'amic';/);
  assert.doesNotMatch(out, /punto y coma/);
  assert.ok(out.includes("EOT;\n$string['zz'] = 'nuevo';\n"));
  assert.ok(out.includes("// $string['commented'] = 'no';"));
});

test('insert sorted', () => {
  const text = "<?php\n\n$string['a'] = 'A';\n$string['c'] = 'C';\n";
  const out = applyEdits(text, computeEdits(text, new Map([['b', 'B'], ['d', 'D'], ['0', '0']])));
  assert.equal(out, "<?php\n\n$string['0'] = '0';\n$string['a'] = 'A';\n$string['b'] = 'B';\n$string['c'] = 'C';\n$string['d'] = 'D';\n");
});

test('empty file', () => {
  const out = applyEdits('<?php\n', computeEdits('<?php\n', new Map([['k', 'v']])));
  assert.equal(out, "<?php\n$string['k'] = 'v';\n");
});

const header = (lang: string) => `<?php
// License.

/**
 * Strings, language '${lang}'.
 */

defined('MOODLE_INTERNAL') || die();
`;

test('mirror layout', () => {
  const en = header('en') + `
// General.
$string['zeta'] = 'Zeta';
$string['alpha'] = 'Alpha';

/* Settings
 * block. */
$string['setting'] = 'Setting'; // Inline note.
$string['other'] = 'Other';
`;
  const es = header('es') + `
$string['alpha'] = 'Alfa';
$string['extra'] = 'Solo en es';
// Nota del traductor.
$string['setting'] = 'Ajuste'; // Nota.
// General.
$string['zeta'] = 'Zeta';
`;
  const out = mirrorLayout(en, es);
  assert.equal(out, header('es') + `
// General.
$string['zeta'] = 'Zeta';
$string['alpha'] = 'Alfa';

/* Settings
 * block. */
// Nota del traductor.
$string['setting'] = 'Ajuste'; // Nota.
$string['extra'] = 'Solo en es';
`);
  assert.equal(mirrorLayout(en, out), out);
  assert.equal(mirrorLayout(en, en), en);
});

test('mirror keeps heredoc and new file', () => {
  const en = "<?php\n$string['a'] = 'A';\n\n// B.\n$string['b'] = 'B';\n";
  const fr = "<?php\n$string['b'] = <<<EOT\nx\nEOT;\n$string['a'] = 'a';\n";
  assert.equal(mirrorLayout(en, fr), "<?php\n$string['a'] = 'a';\n\n// B.\n$string['b'] = <<<EOT\nx\nEOT;\n");
  assert.equal(mirrorLayout(en, '<?php\n'), '<?php\n\n// B.\n');
});

test('diffEdit', () => {
  const e = diffEdit('abcXdef', 'abcYYdef')!;
  assert.deepEqual(e, { start: 3, end: 4, text: 'YY' });
  assert.equal(applyEdits('abcXdef', [e]), 'abcYYdef');
  assert.equal(diffEdit('a', 'a'), null);
});

test('duplicateLines', () => {
  const text = "<?php\n$string['a'] = 'A';\n// $string['b'] = 'comentada';\n$string['b'] = 'B';\n\n$string['a'] = 'A2'; $string['c'] = 'C';\n$string['a'] = <<<EOT\nx\nEOT;\n";
  assert.deepEqual([...duplicateLines(text)], [['a', [2, 6, 7]]]);
  assert.equal(duplicateLines(sample).size, 0);
});

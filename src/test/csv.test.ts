import * as assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../csv';

function test(name: string, fn: () => void) {
  fn();
  console.log('ok -', name);
}

test('ida y vuelta', () => {
  const rows = [
    ['Clave', 'en', 'es'],
    ['a', 'Hello', 'Hola'],
    ['b', 'x; y', 'dice "sí"'],
    ['c', 'Line 1\nLine 2', ''],
    ['d', 'a,b', 'ñ á ü'],
  ];
  const csv = toCsv(rows);
  assert.ok(csv.startsWith('﻿Clave;en;es\r\n'));
  assert.ok(csv.includes('"dice ""sí"""'));
  assert.ok(csv.includes(';a,b;'));
  assert.deepEqual(parseCsv(csv), rows);
});

test('detecta coma y tabulador', () => {
  assert.deepEqual(parseCsv('Clave,en,es\na,"x; y",Hola\n'), [['Clave', 'en', 'es'], ['a', 'x; y', 'Hola']]);
  assert.deepEqual(parseCsv('Clave\ten\na\tb, c'), [['Clave', 'en'], ['a', 'b, c']]);
});

test('filas vacías y finales de línea', () => {
  assert.deepEqual(parseCsv('k;en\r\n\r\n;\r\na;A\r\nb;'), [['k', 'en'], ['a', 'A'], ['b', '']]);
  assert.deepEqual(parseCsv(''), []);
});

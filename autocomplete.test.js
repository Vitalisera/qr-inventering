/* Körs med: node autocomplete.test.js */
const { suggest, distance } = require('./autocomplete.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'eq') + `\n      expected ${sb}\n      actual   ${sa}`);
}
function has(arr, word, msg) {
  if (!arr.some(r => r.word === word))
    throw new Error((msg || 'contains') + ` '${word}' missing in ${JSON.stringify(arr.map(r => r.word))}`);
}
function notHas(arr, word, msg) {
  if (arr.some(r => r.word === word))
    throw new Error((msg || 'notContains') + ` '${word}' should not be in result`);
}

const ord = [
  'skohorn', 'skobolla', 'sko', 'skor', 'skidor', 'skidstavar',
  'kniv', 'köksknivar', 'fårskinn',
  'år', 'år av', 'måtta', 'nål', 'spegel', 'spegelglas',
  'äggvisp', 'ägglåda', 'öronpinne'
];

console.log('autocomplete-engine');

test('Tom input → tom lista', () => {
  eq(suggest('', ord), []);
  eq(suggest('   ', ord), []);
  eq(suggest(null, ord), []);
});

test('words null/undefined → tom lista (ingen krasch)', () => {
  eq(suggest('sko', null), []);
  eq(suggest('sko', undefined), []);
});

test('Substring matchar inom ordet (default mode)', () => {
  const r = suggest('kniv', ord);
  has(r, 'kniv');
  has(r, 'köksknivar');
});

test('Prefix-mode: input "sk" → endast ord som börjar på sk, inga fuzzy', () => {
  const r = suggest('sk', ord, { matchMode: 'prefix' });
  has(r, 'skohorn'); has(r, 'sko'); has(r, 'skor');
  notHas(r, 'fårskinn'); // "sk" finns INTE i början → ej prefix
  if (r.some(x => x.source === 'fuzzy')) throw new Error('Fuzzy ej tillåten på 1–2 tecken med många träffar');
});

test('1 tecken → bara direkta träffar, ingen fuzzy', () => {
  const r = suggest('s', ord);
  if (r.some(x => x.source === 'fuzzy')) throw new Error('Hittade fuzzy på 1 tecken');
});

test('Få direkt-träffar → fyller på med fuzzy (prefix-mode)', () => {
  const r = suggest('skigorn', ord, { matchMode: 'prefix' });
  has(r, 'skohorn');
  if (!r.some(x => x.source === 'fuzzy')) throw new Error('Ingen fuzzy-källa märkt');
});

test('Stavfel: "skogorn" → "skohorn" (granne g→h, kostnad 0.5)', () => {
  const r = suggest('skogorn', ord);
  has(r, 'skohorn');
});

test('Stavfel: "spegrl" → "spegel" (transposition)', () => {
  const r = suggest('spegrl', ord);
  has(r, 'spegel');
});

test('Dedupe: identiska och case-varianter visas en gång', () => {
  const dup = ['sko', 'sko', 'Sko', 'SKO'];
  const r = suggest('sko', dup);
  if (r.length !== 1) throw new Error('Dedupe failed: ' + JSON.stringify(r));
});

test('Svenska tecken (å ä ö) hanteras', () => {
  has(suggest('å', ord), 'år');
  has(suggest('Köks', ord), 'köksknivar');
  has(suggest('ÄGG', ord), 'äggvisp');
  has(suggest('öron', ord), 'öronpinne');
});

test('Sortering — direkta matchningar alfabetiskt', () => {
  const r = suggest('sko', ord, { matchMode: 'prefix' });
  const direct = r.filter(x => x.source === 'prefix').map(x => x.word);
  const sorted = direct.slice().sort((a, b) => a.localeCompare(b, 'sv'));
  eq(direct, sorted, 'direkta ej alfabetiska');
});

test('Sortering — fuzzy efter distans stigande', () => {
  const r = suggest('skigorn', ord, { matchMode: 'prefix' });
  const fuzzy = r.filter(x => x.source === 'fuzzy');
  for (let i = 1; i < fuzzy.length; i++) {
    if (fuzzy[i].distance < fuzzy[i - 1].distance)
      throw new Error('fuzzy ej sorterade efter distans: ' + JSON.stringify(fuzzy));
  }
});

test('Max 8 förslag', () => {
  const big = Array.from({ length: 50 }, (_, i) => `sko${String(i).padStart(2, '0')}`);
  const r = suggest('sko', big);
  if (r.length > 8) throw new Error('Mer än 8 förslag: ' + r.length);
});

test('Källa märkt korrekt', () => {
  const r = suggest('kniv', ord);
  for (const x of r) {
    if (x.source !== 'prefix' && x.source !== 'fuzzy')
      throw new Error('okänd source: ' + x.source);
  }
});

test('Distance-funktion: identiska = 0', () => {
  if (distance('sko', 'sko') !== 0) throw new Error('sko/sko ≠ 0');
});

test('Distance-funktion: granne kostar 0.5', () => {
  // g och h är grannar i svensk QWERTY
  if (distance('g', 'h') !== 0.5) throw new Error('g/h ≠ 0.5: ' + distance('g', 'h'));
});

test('Distance-funktion: transposition kostar 1', () => {
  if (distance('ab', 'ba') !== 1) throw new Error('ab/ba ≠ 1: ' + distance('ab', 'ba'));
});

test('Adaptiv tröskel: 4-tecken-query slipper synonym-brus', () => {
  // "skoh" ska INTE matcha skopa/sked/skal/sil (alla distans ~2 = 50% fel)
  const synonymer = ['skopa', 'sked', 'skal', 'sil', 'skink'];
  const r = suggest('skoh', synonymer);
  for (const x of r) {
    if (x.source === 'fuzzy') throw new Error('Falsk fuzzy på "skoh": ' + x.word + ' d=' + x.distance);
  }
});

test('Adaptiv tröskel: rena typos i 4-tecken-query funkar fortfarande', () => {
  // "krov" → "kniv": distans 1.5 (r→n sub 1, o→i granne 0.5)
  // qlen=4 → effektiv tröskel 1.6 → träffas
  const r = suggest('krov', ['kniv']);
  has(r, 'kniv');
});

test('Adaptiv tröskel: längre queries får tillbaka full tolerans', () => {
  // "skohor" (qlen=6) → tröskel 2.4. "skohorn" distans 1 (deletion) → träffas
  const r = suggest('skohor', ['skohorn', 'skidor']);
  has(r, 'skohorn');
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);

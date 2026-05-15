/* node findtag.test.js — verifierar datakorruption-skyddet i Code.js
   findTagAcrossSheets numeric-fallback.

   Buggen: två fysiskt olika etiketter ("0959773" och "959773") får samma
   numeriska nyckel ("959773"). Gamla koden valde FÖRSTA numeric-träffen → tyst
   skrivning till fel artikelrad. Fixen: numeric-fallback returnerar bara träff
   om EXAKT EN distinkt rad numeric-matchar; >1 → null (hellre "ej hittad").

   Pure-logiken nedan är kopierad ordagrant från Code.js _matchTagInScanned_.
   Håll i synk. (Samma mönster som checksum.test.js — GAS kan ej köras lokalt
   eftersom SpreadsheetApp saknas, så vi testar den extraherade rena logiken.) */

// ---- Kopierat ordagrant från Code.js _matchTagInScanned_ ----
function _matchTagInScanned_(scanned, wanted) {
  if (!wanted) return null;
  const wantedNum = wanted.replace(/^0+/, '') || '0';
  const numericHits = [];
  const seen = {};
  for (const entry of scanned) {
    const cellTags = entry.cellTags || [];
    if (cellTags.indexOf(wanted) !== -1) {
      return { row: entry.row, sheetName: entry.sheetName };
    }
    if (wantedNum !== wanted) {
      for (const t of cellTags) {
        if ((t.replace(/^0+/, '') || '0') === wantedNum) {
          const key = entry.sheetName + '|' + entry.row;
          if (!seen[key]) {
            seen[key] = true;
            numericHits.push({ row: entry.row, sheetName: entry.sheetName });
          }
          break;
        }
      }
    }
  }
  return numericHits.length === 1 ? numericHits[0] : null;
}
// ---- slut kopia ----

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'eq'}: ${actual} !== ${expected}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

console.log('findTagAcrossSheets — datakorruption-skydd');

// (c) Exakt match — opåverkad, prioriteras, returneras direkt
t('exakt match returnerar rätt rad', () => {
  const scanned = [
    { row: 2, sheetName: 'A', cellTags: ['12345'] },
    { row: 3, sheetName: 'A', cellTags: ['959773'] },
  ];
  const r = _matchTagInScanned_(scanned, '959773');
  assert(r, 'skulle hitta');
  eq(r.sheetName, 'A', 'sheet'); eq(r.row, 3, 'row');
});

t('exakt match vinner över numeric-tvetydighet (prioriterad)', () => {
  // wanted "0959773" finns exakt på rad 5, men "959773" numeric-krockar på 3 & 4
  const scanned = [
    { row: 3, sheetName: 'A', cellTags: ['959773'] },
    { row: 4, sheetName: 'B', cellTags: ['00959773'] },
    { row: 5, sheetName: 'A', cellTags: ['0959773'] },
  ];
  const r = _matchTagInScanned_(scanned, '0959773');
  assert(r, 'exakt match ska vinna trots numeric-krock');
  eq(r.sheetName, 'A', 'sheet'); eq(r.row, 5, 'row');
});

t('exakt match på multi-tag-cell opåverkad', () => {
  const scanned = [{ row: 7, sheetName: 'C', cellTags: ['111', '959773', '222'] }];
  const r = _matchTagInScanned_(scanned, '959773');
  assert(r && r.row === 7, 'multi-tag exakt');
});

// (a) Entydig leading-zero-match funkar fortfarande
t('entydig leading-zero-match fungerar (en enda numeric-kandidat)', () => {
  // gsheets har tappat ledande nolla: cell = "959773", sökt = "0959773"
  const scanned = [
    { row: 2, sheetName: 'A', cellTags: ['12345'] },
    { row: 9, sheetName: 'B', cellTags: ['959773'] },
  ];
  const r = _matchTagInScanned_(scanned, '0959773');
  assert(r, 'entydig numeric ska matcha');
  eq(r.sheetName, 'B', 'sheet'); eq(r.row, 9, 'row');
});

t('samma rad numeric-matchar flera gånger = fortf. entydig', () => {
  const scanned = [
    { row: 4, sheetName: 'A', cellTags: ['959773', '0959773'] }, // samma rad
  ];
  const r = _matchTagInScanned_(scanned, '00959773');
  assert(r && r.sheetName === 'A' && r.row === 4, 'en distinkt rad ok');
});

// (b) TVÅ rader 0959773/959773 → null (ingen godtycklig träff) — KÄRNAN
t('TVÅ distinkta rader numeric-krockar -> null (datakorruption-skydd)', () => {
  const scanned = [
    { row: 3, sheetName: 'A', cellTags: ['0959773'] },
    { row: 8, sheetName: 'A', cellTags: ['959773'] },
  ];
  const r = _matchTagInScanned_(scanned, '00959773');
  eq(r, null, 'tvetydig numeric MASTE bli null');
});

t('numeric-krock över olika flikar (ingen exakt) -> null', () => {
  // Sökt "00959773": ingen cell är exakt lika, men 959773 och 0959773 numeric-
  // krockar över två flikar -> tvetydigt -> null
  const scanned = [
    { row: 5, sheetName: 'Reception', cellTags: ['959773'] },
    { row: 5, sheetName: 'Verktyg',   cellTags: ['0959773'] },
  ];
  const r = _matchTagInScanned_(scanned, '00959773');
  eq(r, null, 'krock över flikar -> null');
});

// Noll kandidater -> null (oförändrat beteende)
t('ingen träff alls -> null', () => {
  const scanned = [{ row: 2, sheetName: 'A', cellTags: ['111', '222'] }];
  eq(_matchTagInScanned_(scanned, '999'), null, 'ingen match');
});

t('tom scan -> null', () => {
  eq(_matchTagInScanned_([], '959773'), null, 'tom -> null');
});

t('wanted utan leading zero gör ingen numeric-fallback', () => {
  // wanted "959773" === wantedNum "959773" -> numeric-grenen hoppas över helt;
  // bara exakt match gäller -> ingen exakt cell -> null
  const scanned = [{ row: 3, sheetName: 'A', cellTags: ['0959773'] }];
  eq(_matchTagInScanned_(scanned, '959773'), null, 'ingen numeric-fallback utan ledande nolla i sökt');
});

console.log(`\n${pass}/${pass + fail} passerade`);
process.exit(fail ? 1 : 0);

/* node latency.test.js — verifierar GAS-latensfixens rena cache-härledningslogik.

   Bakgrund: aiSuggest (utan vald plats) och addTagToRow:s kollisionskoll läste
   ~50+ ocachade Sheet-celler per anrop. Fixen härleder samma data ur den redan
   cachade preloadTags-payloaden, med säker full-scan-fallback.

   Pure-logiken nedan är KOPIERAD ORDAGRANT från Code.js
   (_deriveCatsUnitsFromPreload_, _collisionPrecheckFromPreload_, PT).
   Håll i synk. (Samma mönster som findtag.test.js — GAS kan ej köras lokalt.)

   Bevisar:
   (a) härledda kategorier/enheter == vad _distinctCol_ skulle ge (samma
       trim+filter+sort+cross-sheet-aggregat) för en mockad payload.
   (b) kollisionsförhandskoll mot cache hittar känd tag → needsFullScan.
   (c) cache-miss / tom cache → fallback-flagga (full scan körs).
   plus: stale-cache kan aldrig ge felaktig 'clear' vid numeric-tvetydighet. */

// ---- Kopierat ordagrant från Code.js ----
const PT = { TAG: 0, NAME: 1, UNIT: 4, SHEET: 7, ROW: 11, ALTTAGS: 12, CATEGORY: 13 };

function _deriveCatsUnitsFromPreload_(rows) {
  const catBySheet = {};
  const sheetOrder = [];
  const unitSet = new Set();
  for (const r of rows) {
    const sheet = String(r[PT.SHEET] || '');
    if (!(sheet in catBySheet)) { catBySheet[sheet] = new Set(); sheetOrder.push(sheet); }
    const cat = String(r[PT.CATEGORY] || '').trim();
    if (cat) catBySheet[sheet].add(cat);
    const unit = String(r[PT.UNIT] || '').trim();
    if (unit) unitSet.add(unit);
  }
  const perSheet = sheetOrder.map(s => ({
    sheet: s,
    categories: [...catBySheet[s]].sort()
  }));
  return { perSheet: perSheet, allUnits: [...unitSet].sort() };
}

function _collisionPrecheckFromPreload_(rows, wanted) {
  if (!wanted) return { decision: 'needsFullScan', reason: 'no-wanted' };
  const wantedNum = wanted.replace(/^0+/, '') || '0';
  const numericKeys = {};
  let numericCount = 0;
  for (const r of rows) {
    const cellTags = [];
    const pt = String(r[PT.TAG] || '');
    if (pt) cellTags.push(pt);
    const alt = r[PT.ALTTAGS];
    if (Array.isArray(alt)) for (const a of alt) { if (a) cellTags.push(String(a)); }
    if (cellTags.indexOf(wanted) !== -1) {
      return { decision: 'needsFullScan', reason: 'exact-hit-in-cache' };
    }
    if (wantedNum !== wanted) {
      for (const t of cellTags) {
        if ((String(t).replace(/^0+/, '') || '0') === wantedNum) {
          const key = String(r[PT.SHEET] || '') + '|' + r[PT.ROW];
          if (!numericKeys[key]) { numericKeys[key] = true; numericCount++; }
          break;
        }
      }
    }
  }
  if (numericCount > 0) return { decision: 'needsFullScan', reason: 'numeric-hit-in-cache' };
  return { decision: 'clear' };
}
// ---- slut kopia ----

// Referens-orakel: vad den GAMLA _distinctCol_-loopen skulle producera.
// _distinctCol_ = trim, drop tomma, Set, .sort(). Cross-sheet units = union+sort.
function oracleFromSheets(sheets) {
  const perSheet = sheets.map(s => {
    const set = new Set();
    for (const c of s.categoryCells) {
      const v = String(c || '').trim();
      if (v) set.add(v);
    }
    return { sheet: s.name, categories: [...set].sort() };
  });
  const unitSet = new Set();
  for (const s of sheets) for (const u of s.unitCells) {
    const v = String(u || '').trim();
    if (v) unitSet.add(v);
  }
  return { perSheet, allUnits: [...unitSet].sort() };
}

// Bygg en preloadTags-payload ur samma flik-mock (rad per cell-par).
function payloadFromSheets(sheets) {
  const rows = [];
  for (const s of sheets) {
    const n = Math.max(s.categoryCells.length, s.unitCells.length);
    for (let i = 0; i < n; i++) {
      const r = new Array(16).fill('');
      r[PT.TAG] = '';
      r[PT.NAME] = 'artikel' + i;
      r[PT.UNIT] = s.unitCells[i] != null ? s.unitCells[i] : '';
      r[PT.SHEET] = s.name;
      r[PT.ROW] = i + 2;
      r[PT.ALTTAGS] = [];
      r[PT.CATEGORY] = s.categoryCells[i] != null ? s.categoryCells[i] : '';
      rows.push(r);
    }
  }
  return rows;
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(a, b, m) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || 'eq'}: ${A} !== ${B}`);
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

console.log('GAS-latensfix — cache-härledning');

// (a) Härledda kategorier/enheter == _distinctCol_-oraklet
t('(a) härlett cat/unit == _distinctCol_-orakel (trim/dedupe/sort/cross-sheet)', () => {
  const sheets = [
    { name: 'Reception',
      categoryCells: ['Kök', 'Kök ', ' Verktyg', '', 'Förbruk'],
      unitCells: ['st', 'st', 'kg', '', ' liter'] },
    { name: 'Verktygslåda',
      categoryCells: ['Handverktyg', 'Elverktyg', ''],
      unitCells: ['st', 'paket'] },
    { name: 'TomFlik',
      categoryCells: ['', '   '],
      unitCells: [''] },
  ];
  const oracle = oracleFromSheets(sheets);
  const derived = _deriveCatsUnitsFromPreload_(payloadFromSheets(sheets));
  eq(derived.perSheet, oracle.perSheet, 'perSheet kategorier');
  eq(derived.allUnits, oracle.allUnits, 'cross-sheet enheter');
  // explicit förväntan
  eq(derived.allUnits, ['kg', 'liter', 'paket', 'st'], 'enhets-set sorterat & deduped');
});

t('(a2) flik-ordning bevaras (= getCompatibleSheets-ordning)', () => {
  const sheets = [
    { name: 'Z-flik', categoryCells: ['a'], unitCells: ['st'] },
    { name: 'A-flik', categoryCells: ['b'], unitCells: ['kg'] },
  ];
  const d = _deriveCatsUnitsFromPreload_(payloadFromSheets(sheets));
  eq(d.perSheet.map(p => p.sheet), ['Z-flik', 'A-flik'], 'insättningsordning, ej sorterad');
});

// (b) Kollisionsförhandskoll hittar känd tag → needsFullScan
t('(b) exakt tag i cache (primär) -> needsFullScan', () => {
  const rows = [
    (() => { const r = new Array(16).fill(''); r[PT.TAG] = '959773'; r[PT.SHEET] = 'A'; r[PT.ROW] = 3; r[PT.ALTTAGS] = []; return r; })(),
  ];
  const p = _collisionPrecheckFromPreload_(rows, '959773');
  eq(p.decision, 'needsFullScan', 'känd primär tag måste tvinga full scan');
});

t('(b2) känd tag i altTags -> needsFullScan', () => {
  const r = new Array(16).fill('');
  r[PT.TAG] = '111'; r[PT.SHEET] = 'B'; r[PT.ROW] = 5; r[PT.ALTTAGS] = ['222', '959773'];
  const p = _collisionPrecheckFromPreload_([r], '959773');
  eq(p.decision, 'needsFullScan', 'tag i altTags ska träffa');
});

t('(b3) numeric-tvetydig leading-zero i cache -> needsFullScan (datakorruption-skydd)', () => {
  // Sökt "00959773": cache har "959773" och "0959773" på olika rader → numeric-hit
  // → full scan måste avgöra (auktoritativt). Cachen får ALDRIG säga 'clear' här.
  const a = new Array(16).fill(''); a[PT.TAG] = '959773'; a[PT.SHEET] = 'A'; a[PT.ROW] = 3; a[PT.ALTTAGS] = [];
  const b = new Array(16).fill(''); b[PT.TAG] = '0959773'; b[PT.SHEET] = 'A'; b[PT.ROW] = 8; b[PT.ALTTAGS] = [];
  const p = _collisionPrecheckFromPreload_([a, b], '00959773');
  eq(p.decision, 'needsFullScan', 'numeric-tvetydighet -> aldrig clear');
});

t('(b4) ENDA numeric-träff i cache -> ändå needsFullScan (konservativt)', () => {
  // Även en entydig numeric-träff lämnas till auktoritativ scan — cachen avfärdar
  // BARA fall som bevisligen inte finns alls.
  const a = new Array(16).fill(''); a[PT.TAG] = '959773'; a[PT.SHEET] = 'A'; a[PT.ROW] = 3; a[PT.ALTTAGS] = [];
  const p = _collisionPrecheckFromPreload_([a], '0959773');
  eq(p.decision, 'needsFullScan', 'numeric-hit (även entydig) -> full scan');
});

t('(b5) tag finns BEVISLIGEN ingenstans -> clear (snabbväg ok)', () => {
  const a = new Array(16).fill(''); a[PT.TAG] = '111'; a[PT.SHEET] = 'A'; a[PT.ROW] = 2; a[PT.ALTTAGS] = ['222'];
  const b = new Array(16).fill(''); b[PT.TAG] = '333'; b[PT.SHEET] = 'B'; b[PT.ROW] = 9; b[PT.ALTTAGS] = [];
  const p = _collisionPrecheckFromPreload_([a, b], '999888');
  eq(p.decision, 'clear', 'helt frånvarande tag -> clear');
});

t('(b6) syntetisk effectiveTag matchar aldrig riktig sökt tag', () => {
  // tagglös rad får "S<flik>R<rad>" i [TAG]; wanted är ren siffra
  const r = new Array(16).fill(''); r[PT.TAG] = 'SReceptionR4'; r[PT.SHEET] = 'Reception'; r[PT.ROW] = 4; r[PT.ALTTAGS] = [];
  const p = _collisionPrecheckFromPreload_([r], '959773');
  eq(p.decision, 'clear', 'syntetisk tag != riktig tag');
});

// (c) Cache-miss → fallback-flagga (full scan körs). Simulerar anroparens logik.
function simulateAddTagPrecheck(cacheRaw, wanted) {
  // Speglar grenen i addTagToRow: börja needFullScan=true, sätt false ENDAST
  // vid giltig cache + decision==='clear'.
  let needFullScan = true;
  try {
    if (cacheRaw) {
      const rows = JSON.parse(cacheRaw);
      if (Array.isArray(rows)) {
        const pre = _collisionPrecheckFromPreload_(rows, wanted);
        if (pre.decision === 'clear') needFullScan = false;
      }
    }
  } catch (_) { needFullScan = true; }
  return needFullScan;
}

t('(c) cache-miss (null) -> needFullScan=true (auktoritativ scan körs)', () => {
  eq(simulateAddTagPrecheck(null, '959773'), true, 'tom cache -> full scan');
});

t('(c2) korrupt cache-JSON -> needFullScan=true', () => {
  eq(simulateAddTagPrecheck('{ej json', '959773'), true, 'parse-fel -> full scan');
});

t('(c3) cache ej array -> needFullScan=true', () => {
  eq(simulateAddTagPrecheck(JSON.stringify({ foo: 1 }), '959773'), true, 'icke-array -> full scan');
});

t('(c4) giltig cache, tag frånvarande -> needFullScan=false (snabbväg)', () => {
  const r = new Array(16).fill(''); r[PT.TAG] = '111'; r[PT.SHEET] = 'A'; r[PT.ROW] = 2; r[PT.ALTTAGS] = [];
  eq(simulateAddTagPrecheck(JSON.stringify([r]), '999'), false, 'bevisligen clear -> hoppa scan');
});

t('(c5) STALE cache som missar en faktisk numeric-krock -> ändå full scan när den DELVIS syns', () => {
  // Säkerhetskärnan: även om cachen är stale men innehåller EN av de krockande
  // raderna, blir det numeric-hit -> needsFullScan -> auktoritativ scan ser båda.
  const a = new Array(16).fill(''); a[PT.TAG] = '959773'; a[PT.SHEET] = 'A'; a[PT.ROW] = 3; a[PT.ALTTAGS] = [];
  eq(simulateAddTagPrecheck(JSON.stringify([a]), '00959773'), true, 'partiell numeric-träff -> full scan');
});

console.log(`\n${pass}/${pass + fail} passerade`);
process.exit(fail ? 1 : 0);

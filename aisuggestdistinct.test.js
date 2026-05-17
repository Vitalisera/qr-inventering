/* node aisuggestdistinct.test.js — verifierar latens-rot-fixen för aiSuggest
   (no-place-grenen): klienten skickar distinct kategorier/enheter så backend
   HOPPAR getCompatibleSheets()+_distinctCol_-loopen (7–13 s, 80–90 % av tiden).

   GAS kan ej köras lokalt → pure-logiken nedan är KOPIERAD ORDAGRANT från
   app.js (_collectAiDistinct) resp. Code.js (no-place-grenens branch-val +
   _deriveCatsUnitsFromPreload_). Håll i synk. (Samma mönster som
   latency.test.js / findtag.test.js.)

   Bevisar:
   (1) _collectAiDistinct ur tagCache/metaCache == _deriveCatsUnitsFromPreload_
       ur motsvarande preloadTags-payload (samma trim/dedupe/sort/ordning) →
       prompt-innehållet blir byte-identiskt.
   (2) Backend: client-provided icke-tom categories → loopen hoppas
       (clientProvided=true), perSheet-strängar = cache-hit-vägens.
   (3) Bakåtkompatibelt: args utan/ tom categories → fallback-grenen (loop/
       cache) körs precis som förr.
   (4) Tom klient-cache (före preload) → _collectAiDistinct=null → backend
       faller tillbaka. */

// ---- Kopierat ORDAGRANT från app.js (_collectAiDistinct) ----
function makeCollect(tagCache, metaCache) {
  // tagCache/metaCache är Map-lika (values()). Logiken nedan = app.js verbatim.
  if (!tagCache.size) return null;
  const catBySheet = {};
  const sheetOrder = [];
  const unitSet = new Set();
  for (const v of tagCache.values()) {
    const sheet = String(v?.sheetName || v?.place || '');
    if (!(sheet in catBySheet)) { catBySheet[sheet] = new Set(); sheetOrder.push(sheet); }
    const cat = String(v?.category || '').trim();
    if (cat) catBySheet[sheet].add(cat);
  }
  for (const m of metaCache.values()) {
    const u = String(m?.unit || '').trim();
    if (u) unitSet.add(u);
  }
  const perSheet = sheetOrder.map(s => ({
    sheet: s,
    categories: [...catBySheet[s]].sort()
  }));
  const allUnits = [...unitSet].sort();
  if (!perSheet.length && !allUnits.length) return null;
  return { perSheet, allUnits };
}

// ---- Kopierat ORDAGRANT från Code.js ----
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

// Backendens no-place-gren, branch-VAL + perSheet-strängbygge (verbatim-spegel).
// Returnerar { clientProvided, branch, perSheet:[...strängar], units:[...] }.
function backendNoPlaceBranch(args, cachedRows) {
  const perSheet = [];
  const allUnits = new Set();
  const _t = { clientProvided: false, cacheHit: false, sheetCount: 0 };

  const cliCats = (args && Array.isArray(args.categories)) ? args.categories : null;
  const cliUnits = (args && Array.isArray(args.units)) ? args.units : null;
  let branch;
  if (cliCats && cliCats.length) {
    _t.clientProvided = true;
    branch = 'client';
    for (const e of cliCats) {
      const sName = String((e && e.sheet) || '');
      const cats = (e && Array.isArray(e.categories)) ? e.categories : [];
      perSheet.push(sName + ': ' + (cats.length ? cats.join(', ') : '(inga kategorier)'));
    }
    if (cliUnits) for (const u of cliUnits) { if (u) allUnits.add(String(u)); }
    _t.sheetCount = cliCats.length;
  } else {
    if (Array.isArray(cachedRows) && cachedRows.length) {
      _t.cacheHit = true;
      branch = 'cache';
      const d = _deriveCatsUnitsFromPreload_(cachedRows);
      for (const e of d.perSheet) {
        perSheet.push(e.sheet + ': ' + (e.categories.length ? e.categories.join(', ') : '(inga kategorier)'));
      }
      for (const u of d.allUnits) allUnits.add(u);
      _t.sheetCount = d.perSheet.length;
    } else {
      _t.cacheHit = false;
      branch = 'fullscan';
      // (loopen kör _distinctCol_ mot Sheets — ej simulerad här; vi bevisar
      //  bara att DENNA gren tas, dvs. den dyra vägen, vid avsaknad av data)
    }
  }
  return {
    clientProvided: _t.clientProvided,
    cacheHit: _t.cacheHit,
    branch,
    perSheet,
    units: [...allUnits].sort(),
    sheetCount: _t.sheetCount
  };
}

// Bygg preloadTags-payload + matchande klient-cacher ur samma flik-mock.
function fromSheets(sheets) {
  const rows = [];
  const tag = new Map(), meta = new Map();
  let k = 0;
  for (const s of sheets) {
    const n = Math.max(s.categoryCells.length, s.unitCells.length);
    for (let i = 0; i < n; i++) {
      const r = new Array(16).fill('');
      r[PT.TAG] = ''; r[PT.NAME] = 'a' + i;
      r[PT.UNIT] = s.unitCells[i] != null ? s.unitCells[i] : '';
      r[PT.SHEET] = s.name; r[PT.ROW] = i + 2; r[PT.ALTTAGS] = [];
      r[PT.CATEGORY] = s.categoryCells[i] != null ? s.categoryCells[i] : '';
      rows.push(r);
      const key = 'T' + (k++);
      tag.set(key, { sheetName: s.name, category: s.categoryCells[i] != null ? s.categoryCells[i] : '' });
      meta.set(key, { unit: s.unitCells[i] != null ? s.unitCells[i] : '' });
    }
  }
  return { rows, tag, meta };
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

console.log('aiSuggest latens-rot-fix — klient-distinct ⇒ ingen backend-loop');

const SHEETS = [
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

// (1) Klient-distinct == backend-cache-derivat (prompt blir byte-identisk)
t('(1) _collectAiDistinct == _deriveCatsUnitsFromPreload_ (samma trim/dedupe/sort/ordning)', () => {
  const { rows, tag, meta } = fromSheets(SHEETS);
  const client = makeCollect(tag, meta);
  const backend = _deriveCatsUnitsFromPreload_(rows);
  eq(client.perSheet, backend.perSheet, 'perSheet identisk');
  eq(client.allUnits, backend.allUnits, 'allUnits identisk');
  eq(client.allUnits, ['kg', 'liter', 'paket', 'st'], 'enheter sorterade & deduped');
});

t('(1b) flik-ordning = första-sedd (ej sorterad), som backend', () => {
  const { tag, meta } = fromSheets([
    { name: 'Z', categoryCells: ['a'], unitCells: ['st'] },
    { name: 'A', categoryCells: ['b'], unitCells: ['kg'] },
  ]);
  eq(makeCollect(tag, meta).perSheet.map(p => p.sheet), ['Z', 'A'], 'insättningsordning');
});

// (2) Client-provided icke-tom → loopen hoppas, perSheet = cache-vägens
t('(2) client-provided categories → branch=client, clientProvided=true, ingen loop', () => {
  const { rows, tag, meta } = fromSheets(SHEETS);
  const d = makeCollect(tag, meta);
  const cacheVägen = backendNoPlaceBranch({}, rows); // referens (cache-hit-strängar)
  const klientVägen = backendNoPlaceBranch({ categories: d.perSheet, units: d.allUnits }, rows);
  assert(klientVägen.clientProvided === true, 'clientProvided ska flaggas');
  eq(klientVägen.branch, 'client', 'klient-grenen tas');
  eq(klientVägen.perSheet, cacheVägen.perSheet, 'prompt-strängar identiska m. cache-väg');
  eq(klientVägen.units, cacheVägen.units, 'enheter identiska m. cache-väg');
});

t('(2b) klient-grenen tas ÄVEN om backend-cache är tom (rot-orsaken: cache bumpas bort)', () => {
  const { tag, meta } = fromSheets(SHEETS);
  const d = makeCollect(tag, meta);
  const r = backendNoPlaceBranch({ categories: d.perSheet, units: d.allUnits }, null);
  eq(r.branch, 'client', 'ingen cache krävs när klienten skickar data');
  assert(r.clientProvided === true, 'clientProvided=true utan cache');
});

// (3) Bakåtkompatibel fallback — gammal frontend / inga distinct-fält
t('(3) inga categories i args + cache finns → branch=cache (oförändrad)', () => {
  const { rows } = fromSheets(SHEETS);
  const r = backendNoPlaceBranch({ name: 'x' }, rows);
  eq(r.branch, 'cache', 'utan klient-data → cache-väg');
  assert(r.clientProvided === false, 'clientProvided=false (gammal väg)');
});

t('(3b) inga categories + ingen cache → branch=fullscan (oförändrad dyr väg)', () => {
  const r = backendNoPlaceBranch({ name: 'x' }, null);
  eq(r.branch, 'fullscan', 'utan klient-data & cache → full scan-fallback');
  assert(r.clientProvided === false, 'clientProvided=false');
});

t('(3c) tom categories-array → behandlas som ej skickad (fallback)', () => {
  const { rows } = fromSheets(SHEETS);
  const r = backendNoPlaceBranch({ categories: [], units: [] }, rows);
  eq(r.branch, 'cache', 'tom array → ej klient-väg');
  assert(r.clientProvided === false, 'tom array flaggar INTE clientProvided');
});

t('(3d) categories=icke-array (defensivt) → fallback', () => {
  const { rows } = fromSheets(SHEETS);
  const r = backendNoPlaceBranch({ categories: 'oops' }, rows);
  eq(r.branch, 'cache', 'icke-array ignoreras säkert');
});

// (4) Tom klient-cache före preload → _collectAiDistinct=null → backend fallback
t('(4) tom tagCache → _collectAiDistinct=null (klienten skickar inget → fallback)', () => {
  assert(makeCollect(new Map(), new Map()) === null, 'tom cache → null');
});

t('(4b) tagCache utan kategorier/enheter alls → perSheet finns men allUnits tom; ej null', () => {
  // En flik utan kategori/enhet ger fortf. en perSheet-entry (sheet, []) →
  // skickas till backend → klient-grenen tas; "(inga kategorier)" hamnar i prompt
  // exakt som cache-vägen skulle gjort. Bevisa paritet.
  const { rows, tag, meta } = fromSheets([{ name: 'X', categoryCells: ['', ' '], unitCells: ['', ''] }]);
  const d = makeCollect(tag, meta);
  assert(d !== null, 'perSheet-entry finns även utan kategorier');
  const klient = backendNoPlaceBranch({ categories: d.perSheet, units: d.allUnits }, rows);
  const cache = backendNoPlaceBranch({}, rows);
  eq(klient.perSheet, cache.perSheet, '"(inga kategorier)" identiskt m. cache-väg');
});

console.log(`\n${pass}/${pass + fail} passerade`);
process.exit(fail ? 1 : 0);

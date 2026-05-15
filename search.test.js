/* node search.test.js — verifierar Fix 5 (gemensam Search.articles) +
   Fix 4 (Bug C, OFF cross-language semantik).

   FIX 5: Tre sök-callsites (renderSearchResults, openLinkSearchDialog,
   findSimilarItems) hade tre inkonsekventa sök-vägar. openLinkSearchDialog
   använde RÅ substring (name.includes(q)) → "olivilja" matchade INTE
   "Olivolja". Nu delar alla tre Search.articles (samma fuzzy överallt).

   FIX 4 (Bug C): OFF ger ibland bara engelskt namn ("Virgin Olive Oil").
   Lokal Damerau-Levenshtein kan ALDRIG matcha svenska "Olivolja"
   (cross-language). Lösningen: semantisk aiSearch i OFF-flödet. Detta
   testas som en ren mappnings-funktion (AI-resultat → artikel via
   nameResolve-map), eftersom själva aiSearch-anropet är ett backend-API.

   Search.articles nedan är KOPIERAD ORDAGRANT från app.js (Search-objektet).
   Håll i synk. (Samma mönster som findtag.test.js / dedupe.test.js —
   browser-globaler som tagCache finns ej i Node, så vi testar den
   extraherade rena logiken mot den riktiga autocomplete.js-motorn.) */

const Autocomplete = require('./autocomplete.js');

// ---- Kopierat ordagrant från app.js: const Search = { ... } ----
const Search = {
  SUGGEST_OPTS: { matchMode: 'substring', maxSuggestions: 200, minPrefixHits: 8, fuzzyThreshold: 2.5 },
  _buildWordMap(entries) {
    const wordMap = new Map();
    for (const [tag, val] of entries) {
      const name = val && val.name || ""; if (!name) continue;
      const nameKey = name.toLocaleLowerCase('sv');
      if (!wordMap.has(nameKey)) wordMap.set(nameKey, { tag, label: name });
      if (Array.isArray(val.synonyms)) {
        for (const s of val.synonyms) {
          const sn = String(s || "").trim(); if (!sn) continue;
          const sk = sn.toLocaleLowerCase('sv');
          if (!wordMap.has(sk)) wordMap.set(sk, { tag, label: name, syn: sn });
        }
      }
    }
    return wordMap;
  },
  articles(query, entries, opts) {
    if (typeof Autocomplete === 'undefined') return [];
    const qn = (query || "").toLocaleLowerCase('sv').trim();
    if (!qn) return [];
    const wordMap = this._buildWordMap(entries);
    const wordlist = [...wordMap.keys()];
    const o = opts || {};
    let queries = [qn];
    if (o.splitWords) {
      const words = qn.split(/\s+/).filter(w => w.length >= 3);
      queries = words.length ? [qn, ...words] : [qn];
    }
    const sopts = o.fuzzy === false
      ? { matchMode: 'substring', maxSuggestions: o.maxSuggestions || 200, minPrefixHits: 0 }
      : { ...this.SUGGEST_OPTS, ...(o.maxSuggestions ? { maxSuggestions: o.maxSuggestions } : {}) };
    const out = [];
    const seenTag = new Set();
    const seenWord = new Set();
    for (const q of queries) {
      const suggestions = Autocomplete.suggest(q, wordlist, sopts);
      for (const sug of suggestions) {
        if (seenWord.has(sug.word)) continue;
        seenWord.add(sug.word);
        const info = wordMap.get(sug.word); if (!info) continue;
        if (seenTag.has(info.tag)) continue;
        seenTag.add(info.tag);
        out.push({ tag: info.tag, label: info.label, syn: info.syn, source: sug.source });
        if (o.maxSuggestions && out.length >= o.maxSuggestions) return out;
      }
      if (o.maxSuggestions && out.length >= o.maxSuggestions) break;
    }
    return out;
  }
};
// ---- slut kopia ----

// Referens: EXAKT den gamla renderSearchResults-logiken (inline) som
// Search.articles ska vara bit-identisk mot. Bevisar beteende-bevaring.
function oldRenderSearch(qn, entries) {
  const wordMap = new Map();
  for (const [tag, val] of entries) {
    const name = val?.name || ""; if (!name) continue;
    const nameKey = name.toLocaleLowerCase('sv');
    if (!wordMap.has(nameKey)) wordMap.set(nameKey, { tag, label: name });
    if (Array.isArray(val.synonyms)) {
      for (const s of val.synonyms) {
        const sn = String(s || "").trim(); if (!sn) continue;
        const sk = sn.toLocaleLowerCase('sv');
        if (!wordMap.has(sk)) wordMap.set(sk, { tag, label: name, syn: sn });
      }
    }
  }
  const wordlist = [...wordMap.keys()];
  const suggestions = Autocomplete.suggest(qn, wordlist,
    { matchMode: 'substring', maxSuggestions: 200, minPrefixHits: 8, fuzzyThreshold: 2.5 });
  const shown = new Set();
  const out = [];
  for (const sug of suggestions) {
    const info = wordMap.get(sug.word); if (!info) continue;
    if (shown.has(info.tag)) continue;
    shown.add(info.tag);
    out.push(info.tag);
  }
  return out;
}

// Referens: den GAMLA råa substring-loopen från openLinkSearchDialog.
// Bevisar att den missade "olivilja"→"Olivolja" (failing-before).
function oldLinkSubstringLoop(qn, entries) {
  const out = [];
  let count = 0;
  for (const [tag, val] of entries) {
    if (count >= 50) break;
    const name = val?.name || "";
    if (!name || !name.toLocaleLowerCase('sv').includes(qn)) continue;
    out.push(tag);
    count++;
  }
  return out;
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
function eq(a, b, m) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${m || 'eq'}: ${sa} !== ${sb}`);
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

const tagCache = new Map([
  ['t1', { name: 'Olivolja', sheetName: 'Kök', rowNum: 4 }],
  ['t2', { name: 'Kaffe Zoégas', sheetName: 'Reception', rowNum: 9 }],
  ['t3', { name: 'Lasagneplattor', sheetName: 'Kök', rowNum: 12 }],
  ['t4', { name: 'Smör', sheetName: 'Kök', rowNum: 5, synonyms: ['margarin'] }],
  ['S_KökR7', { name: 'Vispgrädde', sheetName: 'Kök', rowNum: 7 }], // syntetisk (ingen tag)
]);
const E = () => tagCache.entries();

console.log('Search.articles — Fix 5 + Fix 4 (Bug C)');

/* ===== FIX 5: beteende-identitet mot gamla renderSearchResults ===== */
t('Search.articles == gamla renderSearchResults (exakt prefix)', () => {
  const a = Search.articles('oliv', E()).map(r => r.tag);
  const b = oldRenderSearch('oliv', E());
  eq(a, b, 'topp-träffar identiska');
  assert(a.includes('t1'), 'Olivolja träffas');
});

t('Search.articles == gamla renderSearchResults (substring mitt i ord)', () => {
  const a = Search.articles('zoégas', E()).map(r => r.tag);
  const b = oldRenderSearch('zoégas', E());
  eq(a, b, 'identisk substring-träff');
  assert(a.includes('t2'), 'Kaffe Zoégas via substring');
});

t('Search.articles == gamla renderSearchResults (synonym)', () => {
  const a = Search.articles('margarin', E()).map(r => r.tag);
  const b = oldRenderSearch('margarin', E());
  eq(a, b, 'synonym-träff identisk');
  assert(a.includes('t4'), 'Smör via synonym margarin');
});

t('Search.articles == gamla renderSearchResults (fuzzy felstavning)', () => {
  const a = Search.articles('olivilja', E()).map(r => r.tag);
  const b = oldRenderSearch('olivilja', E());
  eq(a, b, 'fuzzy-beteende bit-identiskt');
});

t('tom query → []', () => { eq(Search.articles('', E()), []); eq(Search.articles('  ', E()), []); });

/* ===== FIX 5: koppla-dialogen (openLinkSearchDialog) nu fuzzy ===== */
t('FAILING-BEFORE: gamla råa substring-loopen MISSAR olivilja→Olivolja', () => {
  const old = oldLinkSubstringLoop('olivilja', E());
  assert(!old.includes('t1'), 'beviset: gamla loopen hittade INTE Olivolja');
  eq(old, [], 'råa includes() ger noll träffar för felstavning');
});

t('PASSING-AFTER: Search.articles (koppla-dialog-vägen) HITTAR olivilja→Olivolja', () => {
  const hits = Search.articles('olivilja', E(), { maxSuggestions: 50 });
  const tags = hits.map(h => h.tag);
  assert(tags.includes('t1'), 'koppla-dialogen är nu fuzzy → Olivolja träffas');
  assert(hits.find(h => h.tag === 't1').source === 'fuzzy', 'markerad som fuzzy-källa');
});

t('REGRESSION v119: koppla-dialog-vägen prefix-matchar "tvättm"→"Tvättmedel"', () => {
  // Projektägarens skärmdump: query "tvättm" gav INTE "Tvättmedel" i den lokala
  // länk-listan (bara under "Liknande (AI)"). Detta bevisar att Search.articles
  // SJÄLV är korrekt — "tvättm" är ren prefix av "Tvättmedel" och måste ge en
  // prefix-träff (source:'prefix'). Regressionen låg i dubbel-handler-
  // interferensen i openLinkSearchDialog, inte i fuzzy-motorn.
  const cache = new Map([
    ['x1', { name: 'Tvättmedel', sheetName: 'Städ', rowNum: 3 }],
    ['x2', { name: 'Schampoo', sheetName: 'Bad', rowNum: 8 }],
    ['x3', { name: 'Disktrasor', sheetName: 'Kök', rowNum: 2 }],
    ['x4', { name: 'Handsprit', sheetName: 'Bad', rowNum: 11 }],
  ]);
  const hits = Search.articles('tvättm', cache.entries(), { maxSuggestions: 50 });
  const t1 = hits.find(h => h.tag === 'x1');
  assert(t1, '"tvättm" hittar Tvättmedel i koppla-dialog-vägen');
  eq(t1.source, 'prefix', 'prefix-match (inte fuzzy) eftersom "tvättm" är ren prefix');
  assert(!hits.some(h => h.tag === 'x2'), 'Schampoo matchar INTE "tvättm" (avst. 7)');
});

t('koppla-dialog returnerar även syntetiska (ingen tag) artiklar', () => {
  const tags = Search.articles('vispgrädde', E(), { maxSuggestions: 50 }).map(h => h.tag);
  assert(tags.includes('S_KökR7'), 'syntetisk artikel finns kvar i urvalet');
});

t('maxSuggestions kapar resultatet', () => {
  const hits = Search.articles('o', E(), { maxSuggestions: 1 });
  assert(hits.length <= 1, 'respekterar maxSuggestions');
});

/* ===== FIX 5: findSimilarItems splitWords + fuzzy:false ===== */
t('findSimilarItems-väg: per-ord-split matchar ihopskrivet', () => {
  // "Lasagne Plattor" (OFF) → split → "lasagne" matchar "Lasagneplattor"
  const hits = Search.articles('Lasagne Plattor', E(), { splitWords: true, fuzzy: false, maxSuggestions: 3 });
  assert(hits.some(h => h.tag === 't3'), 'split-ord hittar ihopskrivet namn');
});

t('fuzzy:false använder minPrefixHits:0 (ingen fuzzy-brus)', () => {
  // ren substring, ingen fuzzy → felstavning ger INGEN träff i detta läge
  const hits = Search.articles('olivilja', E(), { fuzzy: false, maxSuggestions: 3 });
  assert(!hits.some(h => h.tag === 't1'), 'fuzzy:false → ingen Damerau-fuzzy (avsiktligt)');
});

/* ===== FIX 4 (Bug C): OFF cross-language → semantisk via aiSearch ===== */
// nameResolve-mappningen kopierad ordagrant från showLinkTagDialog OFF-flödet.
function buildNameResolve(entries) {
  const nameResolve = new Map();
  const aiCandidates = [];
  for (const [tag, val] of entries) {
    const nm = val?.name; if (!nm) continue;
    const k = nm.toLocaleLowerCase('sv');
    if (!nameResolve.has(k)) {
      nameResolve.set(k, { tag, name: nm, sheetName: val.sheetName, rowNum: val.rowNum });
      aiCandidates.push(nm);
    }
  }
  return { nameResolve, aiCandidates };
}
function mapAiResults(aiRes, nameResolve) {
  const out = [];
  for (const r of aiRes) {
    const hit = nameResolve.get(String(r.name || '').toLocaleLowerCase('sv'));
    if (hit) out.push(hit);
  }
  return out;
}

t('Bug C bevis: lokal fuzzy KAN INTE matcha "Virgin Olive Oil"→"Olivolja"', () => {
  // cross-language: Damerau-Levenshtein på engelska→svenska = omöjligt
  const local = Search.articles('Virgin Olive Oil', E(), { splitWords: true, fuzzy: false, maxSuggestions: 3 });
  assert(!local.some(h => h.tag === 't1'), 'lokal fuzzy missar (förväntat — Bug C)');
});

t('Bug C fix: aiSearch-resultat ("Olivolja") mappas till artikel via nameResolve', () => {
  const { nameResolve, aiCandidates } = buildNameResolve(E());
  assert(aiCandidates.includes('Olivolja'), 'kandidatlistan skickas till AI');
  // Simulera semantiskt AI-svar för engelska OFF-namnet
  const aiRes = [{ name: 'Olivolja', reason: 'olive oil = olivolja' }];
  const matches = mapAiResults(aiRes, nameResolve);
  eq(matches.map(m => m.tag), ['t1'], 'AI-träff kopplas rätt artikel');
  eq(matches[0].sheetName, 'Kök', 'sheetName medföljer för Save.linkTag');
  eq(matches[0].rowNum, 4, 'rowNum medföljer för Save.linkTag');
});

t('Bug C: AI-namn som inte finns i cachen ignoreras (ingen krasch)', () => {
  const { nameResolve } = buildNameResolve(E());
  eq(mapAiResults([{ name: 'Finns Inte' }], nameResolve), [], 'okänt AI-namn → []');
});

console.log(`\n${pass}/${pass + fail} passerade`);
process.exit(fail ? 1 : 0);
